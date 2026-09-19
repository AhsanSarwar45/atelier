//! Whether a note this server builds is one a push service will actually take.
//!
//! Everything else about the delivery path can be tested without a network,
//! and all of it was: which devices a note is meant for, what the worker is
//! sent, which failures retire a subscription. None of that catches the thing
//! most likely to be wrong. The message is encrypted to the device's keys
//! under RFC 8291 and signed under RFC 8292, and if either is a byte out the
//! push service answers 400 or 401, this server reads a number it has no
//! opinion about, and the phone stays silent. A test with no push service in
//! it cannot tell that apart from working (bw-ndlu.5).
//!
//! So this one is real: it takes the subscriptions a browser actually made,
//! sends a real note, and fails if the service refuses it. It needs a live
//! subscription and a reachable push service, so it is ignored by default and
//! asked for by name:
//!
//! ```text
//! ATELIER_DATA_DIR=/path/used/by/the/running/app \
//!   cargo test --test a_push_reaches_a_real_device -- --ignored --nocapture
//! ```

use atelier::db::Database;
use atelier::push::{self, Note};

#[tokio::test]
#[ignore = "needs a subscription made by a real browser and a reachable push service"]
async fn a_note_this_server_sends_is_one_the_push_service_accepts() {
    let db = Database::new().expect("the settings database named by ATELIER_DATA_DIR");
    let devices = push::registrations(&db).expect("the stored subscriptions");
    assert!(
        !devices.is_empty(),
        "no device is subscribed in this data directory, so there is nothing to prove; \
         turn device notifications on in Settings first"
    );

    let http = reqwest::Client::new();
    let note = Note {
        title: "Atelier".to_string(),
        body: "A chat is waiting on you.".to_string(),
        href: "/workbench".to_string(),
        needs_action: true,
    };

    let sent = push::deliver(&db, &http, &note)
        .await
        .expect("the push service answered");
    assert_eq!(
        sent,
        devices.len(),
        "the push service refused a message this server built, so a phone would have stayed silent"
    );
}
