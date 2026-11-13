//! A grid's approved check files are not locked either (docs/grids.md,
//! "Proof"): a cell whose check file changed since approval still proves,
//! and its proof names the changed file for the owner.

use super::tests::{draft, draft_payload, found, on, owner_says, passing, proof_payload, request, state, store};
use super::*;

#[test]
fn a_changed_check_file_does_not_refuse_prove_and_the_proof_names_it() {
    let (_d, store) = store();
    owner_says(&store, "s1", "@matrix the camera area");
    let mut payload = draft_payload("camera");
    payload["columns"][0]["checks"][0]["files"] = json!(["tests/{row}_gpu.rs"]);
    draft(&store, "s1", payload, vec![found("glare", &["camera/glare.rs"]), found("sunstar", &["camera/sunstar.rs"])]).unwrap();
    let mut approve = request("approve", "owner", None, "camera");
    approve.hashes = Some(json!({"files": {"tests/glare_gpu.rs": "a1", "tests/sunstar_gpu.rs": "b1", "tests/common.rs": "c1"}}));
    apply(store.connection(), &approve).unwrap();

    let mut asked = on(request("prove", "agent", Some("s1"), "camera"), "glare", "gpu");
    asked.payload = proof_payload();
    asked.checks = passing();
    asked.fingerprint = Some("f1".into());
    asked.head = Some("h1".into());
    asked.hashes = Some(json!({"files": {"tests/glare_gpu.rs": "a2", "tests/sunstar_gpu.rs": "b1", "tests/common.rs": "c2"}}));
    if let Err(TaskError::Refused(message) | TaskError::Failed(message)) = apply(store.connection(), &asked) {
        panic!("LOCKED: prove was refused: {message}");
    }
    let cell = state(&store, "camera", "glare", "gpu");
    assert_eq!(cell.state, "proved");
    let changed = cell.proof.unwrap()["changedCheckFiles"].clone();
    assert_eq!(changed, json!(["tests/glare_gpu.rs", "tests/common.rs"]), "the proof names the changed files for the owner");
}
