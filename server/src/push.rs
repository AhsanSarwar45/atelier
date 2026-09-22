//! Reaching a device whose app is closed.
//!
//! The open page can draw a notification for as long as it is running, which
//! on a phone is a few seconds after you look away: the operating system
//! freezes a backgrounded web app, and a frozen page notices nothing. So the
//! browser's own push service is told where this device lives, that address is
//! kept here, and the notification is encrypted and posted to it by the server
//! instead — which works whether or not any window is left (bw-ndlu.3).
//!
//! The crypto is `web-push`: RFC 8291 for the message encryption and RFC 8292
//! for the VAPID signature. Every HTTP client that crate ships is built on
//! OpenSSL, so only its message building is used and the send is done with the
//! `reqwest` this server already has, which is rustls.

use std::sync::Arc;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use jwt_simple::prelude::ES256KeyPair;
use serde::{Deserialize, Serialize};
use web_push::{
    ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushMessage, WebPushMessageBuilder,
};

use crate::db::Database;

/// The server's half of the VAPID pair, base64url, made once and kept.
const PRIVATE_KEY: &str = "notifications.push.vapid-key";
/// Every device that asked to be pushed to, as a JSON array.
const REGISTRATIONS: &str = "notifications.push.devices";

/// Who a push service should complain to about this application server. VAPID
/// requires the claim; nothing reads it here, and it names the product rather
/// than whoever happens to be running this copy.
const CONTACT: &str = "mailto:atelier@localhost";

/// How long a push service should hold a notification for a device that is
/// off. A day: longer than a phone spends in a pocket, short enough that
/// nobody is told about a chat from last week.
const TTL_SECONDS: u32 = 60 * 60 * 24;

/// One browser on one device, and what it asked to hear about.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    #[serde(default = "yes")]
    pub needs_action: bool,
    #[serde(default = "yes")]
    pub updates: bool,
}

fn yes() -> bool {
    true
}

/// What to say, and which of the two kinds of thing it is.
#[derive(Clone, Debug, Serialize)]
pub struct Note {
    pub title: String,
    pub body: String,
    pub href: String,
    /// True when this is a chat stopped for the owner rather than one that
    /// merely finished, which is the line the two preferences are drawn on.
    #[serde(skip)]
    pub needs_action: bool,
}

impl Note {
    /// The payload the worker reads. `tag` is the chat, so a chat that changes
    /// twice replaces its own notification instead of stacking a second one.
    fn body_json(&self) -> Vec<u8> {
        serde_json::json!({
            "title": self.title,
            "body": self.body,
            "href": self.href,
            "tag": self.href,
        })
        .to_string()
        .into_bytes()
    }

    fn wanted_by(&self, device: &Registration) -> bool {
        if self.needs_action {
            device.needs_action
        } else {
            device.updates
        }
    }
}

/// The private key, made and stored the first time it is asked for.
///
/// Generating it lazily rather than at startup means a copy of Atelier that
/// nobody ever turns notifications on for never grows a key it does not use.
fn private_key(db: &Database) -> Result<String, String> {
    if let Some(stored) = db.setting(PRIVATE_KEY).map_err(|e| e.to_string())? {
        if !stored.trim().is_empty() {
            return Ok(stored);
        }
    }
    let made = URL_SAFE_NO_PAD.encode(ES256KeyPair::generate().to_bytes());
    db.set_setting(PRIVATE_KEY, Some(&made))
        .map_err(|e| e.to_string())?;
    Ok(made)
}

/// The half of the pair a browser needs to subscribe, as base64url.
pub fn public_key(db: &Database) -> Result<String, String> {
    let private = private_key(db)?;
    let builder = VapidSignatureBuilder::from_base64_no_sub(&private)
        .map_err(|e| format!("the stored push key cannot be read: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(builder.get_public_key()))
}

pub fn registrations(db: &Database) -> Result<Vec<Registration>, String> {
    let stored = db.setting(REGISTRATIONS).map_err(|e| e.to_string())?;
    let Some(stored) = stored.filter(|s| !s.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    // A device whose record cannot be read is dropped rather than taking the
    // whole list with it: the browser will register again next time.
    Ok(serde_json::from_str(&stored).unwrap_or_default())
}

fn store(db: &Database, devices: &[Registration]) -> Result<(), String> {
    let written = serde_json::to_string(devices).map_err(|e| e.to_string())?;
    db.set_setting(REGISTRATIONS, Some(&written))
        .map_err(|e| e.to_string())
}

/// Remember a device, replacing any earlier record of the same endpoint —
/// which is what a browser sends when only the preferences changed.
pub fn remember(db: &Database, device: Registration) -> Result<(), String> {
    let mut devices = registrations(db)?;
    devices.retain(|d| d.endpoint != device.endpoint);
    devices.push(device);
    store(db, &devices)
}

pub fn forget(db: &Database, endpoint: &str) -> Result<(), String> {
    let mut devices = registrations(db)?;
    devices.retain(|d| d.endpoint != endpoint);
    store(db, &devices)
}

/// Encrypt one note for one device. Separated from the send so a test can
/// check what would go on the wire without a push service to send it to.
pub fn seal(private_key_base64: &str, device: &Registration, note: &Note) -> Result<WebPushMessage, String> {
    let info = SubscriptionInfo::new(&device.endpoint, &device.p256dh, &device.auth);
    let mut signature = VapidSignatureBuilder::from_base64(private_key_base64, &info)
        .map_err(|e| format!("the stored push key cannot be read: {e}"))?;
    signature.add_claim("sub", CONTACT);
    let signature = signature
        .build()
        .map_err(|e| format!("the push signature could not be made: {e}"))?;

    let mut message = WebPushMessageBuilder::new(&info);
    let payload = note.body_json();
    message.set_payload(ContentEncoding::Aes128Gcm, &payload);
    message.set_vapid_signature(signature);
    message.set_ttl(TTL_SECONDS);
    message
        .build()
        .map_err(|e| format!("the push message could not be built: {e}"))
}

/// Post one sealed message, mirroring the headers `web_push`'s own
/// `request_builder` sets, because the send is ours rather than the crate's.
async fn post(http: &reqwest::Client, message: WebPushMessage) -> Result<reqwest::StatusCode, String> {
    let mut request = http
        .post(message.endpoint.to_string())
        .header("TTL", message.ttl.to_string());
    if let Some(payload) = message.payload {
        request = request
            .header("Content-Encoding", payload.content_encoding.to_str())
            .header("Content-Length", payload.content.len().to_string())
            .header("Content-Type", "application/octet-stream");
        for (name, value) in payload.crypto_headers {
            request = request.header(name, value);
        }
        request = request.body(payload.content);
    }
    let answer = request.send().await.map_err(|e| e.to_string())?;
    Ok(answer.status())
}

/// Send one note to every device that asked for its kind.
///
/// A device the push service has retired answers 404 or 410; that is the only
/// signal a browser ever gives that a subscription is dead, so it is taken and
/// the record dropped. Every other failure is left alone — a push service that
/// is briefly down must not cost the owner his phone.
pub async fn deliver(db: &Database, http: &reqwest::Client, note: &Note) -> Result<usize, String> {
    let devices = registrations(db)?;
    if devices.is_empty() {
        return Ok(0);
    }
    let private = private_key(db)?;

    let mut sent = 0usize;
    let mut retired = Vec::new();
    for device in &devices {
        if !note.wanted_by(device) {
            continue;
        }
        let message = match seal(&private, device, note) {
            Ok(message) => message,
            Err(why) => {
                tracing::warn!("a push could not be sealed for {}: {why}", device.endpoint);
                continue;
            }
        };
        match post(http, message).await {
            Ok(status) if status.is_success() => sent += 1,
            Ok(status) if status == 404 || status == 410 => retired.push(device.endpoint.clone()),
            Ok(status) => tracing::warn!("a push service answered {status} for {}", device.endpoint),
            Err(why) => tracing::warn!("a push could not be sent to {}: {why}", device.endpoint),
        }
    }

    if !retired.is_empty() {
        let mut left = registrations(db)?;
        left.retain(|d| !retired.contains(&d.endpoint));
        store(db, &left)?;
    }
    Ok(sent)
}

/// Watch every chat's state and push what the open page would have drawn.
///
/// The page does this too, in `WorkbenchStatus`, and the two overlap while a
/// window happens to be open — the notification carries the chat as its `tag`,
/// so the second one drawn replaces the first rather than doubling it. What
/// the page cannot do is this with no window, which is the whole point.
///
/// What has already been announced is written down (`session_notice`), not
/// held here. It used to be a `HashMap` seeded at startup from the board as it
/// stood — which made the record only as durable as the process, and only as
/// correct as that one read. A restart after the read failed announced every
/// chat on the board a second time, and the owner had no way to stop it: the
/// clearing he had already done was kept somewhere else entirely (bw-altj).
pub fn watch(db: Arc<Database>, workbench: crate::routes::workbench::WorkbenchState) {
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;

        let http = reqwest::Client::new();
        let mut updates = workbench.database().subscribe_all();

        loop {
            let update = match updates.recv().await {
                Ok(update) => update,
                // Falling behind loses notifications, not correctness: the
                // next change for that chat is still announced.
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("push watching fell {missed} events behind");
                    continue;
                }
                Err(RecvError::Closed) => break,
            };

            if update.event.kind != crate::workbench::protocol::EventKind::SessionState {
                continue;
            }
            let Some(state) = update.event.fields.get("state").and_then(serde_json::Value::as_str) else {
                continue;
            };

            // Whether there is anything to say is one question with one answer,
            // asked here and on the page's behalf by the notifications route.
            let Some(projects) = workbench.projects() else {
                continue;
            };
            let row = match crate::workbench::notice::worth_pushing(
                workbench.database(),
                projects,
                &update.session_id,
                state,
            )
            .await
            {
                Ok(Some(row)) => row,
                Ok(None) => continue,
                Err(why) => {
                    tracing::warn!("a chat could not be read to push about it: {why}");
                    continue;
                }
            };

            // Written down before it is sent, not after. A push service that is
            // briefly refusing must not turn into the same chat announced over
            // and over, which is the complaint this whole job is about; a send
            // that fails is one notification missed, and the chat's next change
            // says so again.
            if let Err(why) = workbench
                .database()
                .mark_announced(
                    update.session_id.clone(),
                    state.to_string(),
                    chrono::Utc::now().to_rfc3339(),
                )
                .await
            {
                tracing::warn!("what was announced about a chat could not be written down: {why}");
            }

            let note = Note {
                // Already a name rather than a raw title, and the same name
                // the tray and the rail draw for this chat (notice::naming).
                title: row.name,
                body: row.says,
                href: row.href,
                needs_action: row.needs_action,
            };
            if let Err(why) = deliver(&db, &http, &note).await {
                tracing::warn!("a push could not be delivered: {why}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_device() -> Registration {
        // A real subscription's shape: the p256dh is an uncompressed P-256
        // point and the auth is sixteen bytes, both base64url.
        Registration {
            endpoint: "https://push.example.com/one".into(),
            p256dh: "BLMbF9ffKBiWQLCKvTHb6LO8Nb6dcUh6TItC455vu2kElga6PQvUmaFyCdykxY2nOSSL3yKgfbmFLRTUaGv4yV8".into(),
            auth: "xS03Fi5ErfTNH_l9WHE9Ig".into(),
            needs_action: true,
            updates: true,
        }
    }

    fn a_note() -> Note {
        Note {
            title: "A chat".into(),
            body: "waiting on you".into(),
            href: "/chat/7".into(),
            needs_action: true,
        }
    }

    #[test]
    fn a_note_goes_only_to_a_device_that_asked_for_its_kind() {
        let note = Note { needs_action: false, ..a_note() };
        let mut device = a_device();
        device.updates = false;
        assert!(!note.wanted_by(&device), "an update reached a device that turned updates off");
        device.updates = true;
        assert!(note.wanted_by(&device));

        let urgent = a_note();
        let mut deaf = a_device();
        deaf.needs_action = false;
        assert!(!urgent.wanted_by(&deaf), "a needs-action note reached a device that turned them off");
    }

    #[test]
    fn a_sealed_message_carries_the_encrypted_body_and_its_vapid_headers() {
        let key = URL_SAFE_NO_PAD.encode(ES256KeyPair::generate().to_bytes());
        let message = seal(&key, &a_device(), &a_note()).expect("the message should seal");
        let payload = message.payload.expect("a note always has a body");

        assert_eq!(payload.content_encoding.to_str(), "aes128gcm");
        assert!(
            !payload.content.is_empty(),
            "the body was not encrypted into the message"
        );
        // The plain text must not survive into what goes on the wire.
        assert!(
            !payload.content.windows(7).any(|w| w == b"waiting"),
            "the note's text was sent unencrypted"
        );
        let names: Vec<&str> = payload.crypto_headers.iter().map(|(n, _)| *n).collect();
        assert!(
            names.contains(&"Authorization"),
            "the VAPID signature is missing: {names:?}"
        );
    }

    // Which states are worth a word, and what a chat's link looks like, used to
    // be asserted here as well — because the page and this file each spelled
    // them out, once in TypeScript and once in Rust, and the pair could drift
    // apart without anything failing. There is one spelling now
    // (`workbench::notice`) and it is tested where it lives. A second copy of
    // those assertions would only say the same module agrees with itself.

    #[test]
    fn a_payload_names_the_chat_so_one_chat_keeps_one_notification() {
        let note = a_note();
        let sent: serde_json::Value = serde_json::from_slice(&note.body_json()).unwrap();
        assert_eq!(sent["tag"], "/chat/7");
        assert_eq!(sent["href"], "/chat/7");
        assert_eq!(sent["title"], "A chat");
    }
}
