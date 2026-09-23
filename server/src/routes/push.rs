//! Signing a device up to be pushed to, and telling it which key to use.
//!
//! Held by the server rather than the browser for the same reason the search
//! settings are: the thing that sends the notification is the server, and it
//! has to still know where to send when no browser is running (bw-ndlu.3).

use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use crate::push::{self, Registration};
use crate::routes::projects::AppState;

type Refusal = (StatusCode, String);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicKey {
    /// `null` when this copy cannot make a key at all, which the settings
    /// screen reads as "notifications work only while a window is open".
    key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Leaving {
    endpoint: String,
}

/// GET /api/push/key
async fn key(State(db): State<AppState>) -> Json<PublicKey> {
    match push::public_key(&db) {
        Ok(key) => Json(PublicKey { key: Some(key) }),
        Err(why) => {
            tracing::warn!("no push key could be made: {why}");
            Json(PublicKey { key: None })
        }
    }
}

/// POST /api/push/subscribe
///
/// Sent again whenever the preferences change, so the same endpoint arriving
/// twice replaces the earlier record rather than adding a second one.
async fn subscribe(
    State(db): State<AppState>,
    Json(device): Json<Registration>,
) -> Result<StatusCode, Refusal> {
    if device.endpoint.trim().is_empty()
        || device.p256dh.trim().is_empty()
        || device.auth.trim().is_empty()
    {
        return Err((
            StatusCode::UNPROCESSABLE_ENTITY,
            "A device has to give an endpoint and both of its keys to be pushed to.".into(),
        ));
    }
    push::remember(&db, device)
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|why| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("This device could not be remembered: {why}"),
            )
        })
}

/// DELETE /api/push/subscribe
async fn unsubscribe(
    State(db): State<AppState>,
    Json(leaving): Json<Leaving>,
) -> Result<StatusCode, Refusal> {
    push::forget(&db, &leaving.endpoint)
        .map(|()| StatusCode::NO_CONTENT)
        .map_err(|why| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("This device could not be forgotten: {why}"),
            )
        })
}

/// The routes, behind the guard the settings next door wear.
pub fn push_routes() -> Router<AppState> {
    Router::new()
        .route("/push/key", get(key))
        .route("/push/subscribe", post(subscribe).delete(unsubscribe))
        .layer(middleware::from_fn(crate::local_host::require_local_host))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use axum::body::Body;
    use axum::http::{header, Method, Request};
    use serde_json::{json, Value};
    use std::sync::Arc;
    use tower::ServiceExt;

    fn app(db: &AppState) -> Router {
        Router::new().nest("/api", push_routes().with_state(Arc::clone(db)))
    }

    async fn call(
        db: &AppState,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Vec<u8>) {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "localhost")
            .header(header::CONTENT_TYPE, "application/json");
        let request = match body {
            Some(value) => request.body(Body::from(value.to_string())).unwrap(),
            None => request.body(Body::empty()).unwrap(),
        };
        let answer = app(db).oneshot(request).await.unwrap();
        let status = answer.status();
        let bytes = axum::body::to_bytes(answer.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, bytes.to_vec())
    }

    fn a_db() -> AppState {
        Arc::new(Database::new_in_memory().expect("an in-memory database"))
    }

    #[tokio::test]
    async fn the_key_is_offered_and_is_the_same_one_next_time() {
        let db = a_db();
        let (status, body) = call(&db, Method::GET, "/api/push/key", None).await;
        assert_eq!(status, StatusCode::OK);
        let first: Value = serde_json::from_slice(&body).unwrap();
        let key = first["key"].as_str().expect("a key").to_string();
        assert!(!key.is_empty());

        let (_, body) = call(&db, Method::GET, "/api/push/key", None).await;
        let again: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            again["key"].as_str().unwrap(),
            key,
            "a second visit made a new key, which would strand every device already subscribed"
        );
    }

    #[tokio::test]
    async fn a_device_is_remembered_once_however_often_it_registers() {
        let db = a_db();
        let device = json!({
            "endpoint": "https://push.example.com/one",
            "p256dh": "BLMbF9ffKBiWQLCKvTHb6LO8Nb6dcUh6TItC455vu2kElga6PQvUmaFyCdykxY2nOSSL3yKgfbmFLRTUaGv4yV8",
            "auth": "xS03Fi5ErfTNH_l9WHE9Ig",
            "needsAction": true,
            "updates": true,
        });
        let (status, _) = call(
            &db,
            Method::POST,
            "/api/push/subscribe",
            Some(device.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let mut changed = device.clone();
        changed["updates"] = json!(false);
        let (status, _) = call(&db, Method::POST, "/api/push/subscribe", Some(changed)).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let devices = push::registrations(&db).unwrap();
        assert_eq!(devices.len(), 1, "the same endpoint was stored twice");
        assert!(
            !devices[0].updates,
            "the second registration did not replace the first"
        );
    }

    #[tokio::test]
    async fn a_device_that_leaves_is_forgotten() {
        let db = a_db();
        let device = json!({
            "endpoint": "https://push.example.com/one",
            "p256dh": "BLMbF9ffKBiWQLCKvTHb6LO8Nb6dcUh6TItC455vu2kElga6PQvUmaFyCdykxY2nOSSL3yKgfbmFLRTUaGv4yV8",
            "auth": "xS03Fi5ErfTNH_l9WHE9Ig",
            "needsAction": true,
            "updates": true,
        });
        call(&db, Method::POST, "/api/push/subscribe", Some(device)).await;
        let (status, _) = call(
            &db,
            Method::DELETE,
            "/api/push/subscribe",
            Some(json!({ "endpoint": "https://push.example.com/one" })),
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(push::registrations(&db).unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_device_with_no_keys_is_refused_rather_than_stored() {
        let db = a_db();
        let (status, _) = call(
            &db,
            Method::POST,
            "/api/push/subscribe",
            Some(json!({ "endpoint": "https://push.example.com/one", "p256dh": "", "auth": "" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(push::registrations(&db).unwrap().is_empty());
    }
}
