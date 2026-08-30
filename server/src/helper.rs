//! The chat helper, carried inside the product.
//!
//! Talking to an agent is one of the things this is for, so the helper travels
//! in the binary and is written out beside the data the first time the product
//! runs. Before this it was started from the machine it was BUILT on — the
//! path was baked in at compile time — so on any other computer the Chat tab
//! had nothing behind it (bw-8um.3.9).
//!
//! ## Two sets, one folder, and why the shape matters
//!
//! The helper's own files sit under `workbench/`, and they read a dozen
//! modules the screens read too, by walking up out of their own folder:
//! `../../../src/workbench/protocol.ts`. So the two are laid down keeping the
//! distance between them, which is what makes those imports resolve without a
//! single line of the helper being rewritten:
//!
//! ```text
//! <helper>/workbench/src/server.ts       <- what gets started
//! <helper>/workbench/package.json        <- and the lock beside it
//! <helper>/workbench/node_modules/…      <- fetched here, once, on first run
//! <helper>/src/workbench/*.ts            <- the modules it shares with the screens
//! ```
//!
//! Both sets share one marker, so a change to either rewrites both and no
//! half-updated helper is ever left behind.
//!
//! ## What is NOT carried, and why
//!
//! The kit the helper talks to Claude with. It is Anthropic's, published under
//! "all rights reserved", so putting a copy inside a binary we hand to somebody
//! else would be us redistributing their program. It is fetched onto
//! the reader's own machine instead, straight from where the lock this build
//! carries says each piece lives — which is where they would have got it
//! anyway, and leaves the licence between them and its author.
//!
//! Claude Code itself is not carried either, for a second reason on top of that
//! one: the kit ships a copy weighing a third of a gigabyte per platform, and
//! the reader already has the one they signed into. `workbench/src/claude-program.ts`
//! is where the helper goes looking for theirs.

use base64::Engine;
use rust_embed::Embed;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The helper's own files: everything it runs, and the two package files that
/// say what it needs. Its tests stay behind — they are for this repository,
/// not for the reader's machine.
#[derive(Embed)]
#[folder = "../workbench/"]
#[include = "package.json"]
#[include = "package-lock.json"]
#[include = "src/**/*.ts"]
#[exclude = "src/__tests__/*"]
struct Helper;

/// The modules the helper shares with the screens.
///
/// Every plain module is carried, not the dozen the helper reads today: the
/// helper gaining an import is a one-line change nobody would think to mirror
/// here, and the cost of being wrong is a chat that dies on a stranger's
/// machine. The `.tsx` files are the screens themselves and no help to a
/// program with no browser in it.
#[derive(Embed)]
#[folder = "../src/workbench/"]
#[include = "*.ts"]
// A pattern here matches across folders — `*.ts` alone reaches into
// `__tests__/` — so what stays behind is said outright.
#[exclude = "__tests__/*"]
struct Shared;

/// The helper's own package, under the folder everything is laid down in.
const PACKAGE: &str = "workbench";

/// The file that is started, under the same folder.
const ENTRY: &str = "workbench/src/server.ts";

/// The one file that says the kit really is there. A `node_modules` folder can
/// exist and hold nothing after an install that was interrupted.
const KIT: &str = "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs";

/// What the kit that is there was fetched against.
const KIT_MARKER: &str = ".kit";

/// A helper written out and ready to be started.
pub struct Laid {
    /// The file `node` is pointed at.
    pub entry: PathBuf,
    /// The folder its package sits in, where the kit is fetched.
    pub package: PathBuf,
}

#[derive(Serialize)]
struct PresentationRequest<'a> {
    args: &'a [String],
    stdin: String,
    files: std::collections::BTreeMap<String, String>,
}

fn uploaded_request<'a>(
    rest: &'a [String],
    stdin: String,
    upload_flags: &[&str],
) -> Result<PresentationRequest<'a>, String> {
    let mut files = std::collections::BTreeMap::new();
    for (at, word) in rest.iter().enumerate() {
        if upload_flags.contains(&word.as_str()) {
            let path = rest
                .get(at + 1)
                .ok_or_else(|| format!("missing value for {word}"))?;
            let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
            files.insert(
                path.clone(),
                base64::engine::general_purpose::STANDARD.encode(bytes),
            );
        }
    }
    Ok(PresentationRequest {
        args: rest,
        stdin,
        files,
    })
}

fn presentation_request(rest: &[String], stdin: String) -> Result<PresentationRequest<'_>, String> {
    uploaded_request(rest, stdin, &["--file", "--input", "--before", "--after"])
}

fn screen_check_request(rest: &[String]) -> Result<PresentationRequest<'_>, String> {
    let mut files = std::collections::BTreeMap::new();
    for (at, word) in rest.iter().enumerate() {
        if !matches!(word.as_str(), "--target" | "--before" | "--after") {
            continue;
        }
        let path = rest
            .get(at + 1)
            .ok_or_else(|| format!("missing value for {word}"))?;
        if word == "--target" && (path.starts_with("http://") || path.starts_with("https://")) {
            continue;
        }
        let bytes = std::fs::read(path).map_err(|error| format!("{path}: {error}"))?;
        files.insert(
            path.clone(),
            base64::engine::general_purpose::STANDARD.encode(bytes),
        );
    }
    Ok(PresentationRequest {
        args: rest,
        stdin: String::new(),
        files,
    })
}

/// Hand temporary files to the running app; only its sidecar writes durable media.
pub async fn present(rest: &[String]) -> Result<i32, String> {
    use std::io::Read;
    let mut stdin = String::new();
    std::io::stdin()
        .read_to_string(&mut stdin)
        .map_err(|error| format!("stdin: {error}"))?;
    let port = std::env::var("ATELIER_PORT")
        .or_else(|_| std::env::var("BEADS_WEB_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    let output = present_to(rest, stdin, &format!("http://127.0.0.1:{port}")).await?;
    print!("{output}");
    Ok(0)
}

async fn present_to(rest: &[String], stdin: String, base: &str) -> Result<String, String> {
    let request = presentation_request(rest, stdin)?;
    let response = reqwest::Client::new()
        .post(format!("{base}/api/workbench/present"))
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            format!("Presentation failed: {error}")
        })?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|error| {
        format!("Invalid presentation response: {error}")
    })?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|error| error.as_str())
            .unwrap_or("Atelier refused the presentation")
            .to_string());
    }
    let output = value
        .get("output")
        .and_then(|output| output.as_str())
        .ok_or_else(|| "Atelier returned no presentation output".to_string())?;
    Ok(output.to_string())
}

/// Capture or assess a screen through the running app and print its evidence manifest.
pub async fn screen_check(rest: &[String]) -> Result<i32, String> {
    let port = std::env::var("ATELIER_PORT")
        .or_else(|_| std::env::var("BEADS_WEB_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(crate::command_line::PORT);
    let output = screen_check_to(rest, &format!("http://127.0.0.1:{port}")).await?;
    println!(
        "{}",
        serde_json::to_string_pretty(&output).map_err(|error| error.to_string())?
    );
    Ok(0)
}

async fn screen_check_to(rest: &[String], base: &str) -> Result<serde_json::Value, String> {
    let request = screen_check_request(rest)?;
    let response = reqwest::Client::new()
        .post(format!("{base}/api/workbench/screen-check"))
        .json(&request)
        .send()
        .await
        .map_err(|error| {
            format!("Screen check failed: {error}")
        })?;
    let status = response.status();
    let value: serde_json::Value = response.json().await.map_err(|error| {
        format!("Invalid screen-check response: {error}")
    })?;
    if !status.is_success() {
        return Err(value
            .get("error")
            .and_then(|error| error.as_str())
            .unwrap_or("Atelier refused the screen check")
            .to_string());
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "Atelier returned no screen-check result".to_string())
}

/// Lay the helper down beside the data.
///
/// Returns what went wrong rather than stopping the program: a copy that
/// cannot write there still serves the board, and only the Chat tab suffers.
pub fn install() -> Result<Laid, String> {
    let Some(dir) = crate::identity::helper_dir() else {
        return Err("this computer names no folder for a program's data".to_string());
    };

    let mut files = crate::laid_down::gather::<Helper>(PACKAGE)?;
    files.extend(crate::laid_down::gather::<Shared>("src/workbench")?);
    crate::laid_down::install(&dir, &files)?;

    Ok(Laid {
        entry: dir.join(ENTRY),
        package: dir.join(PACKAGE),
    })
}

/// Fetch the kit the helper talks to Claude with, if it is not already there.
///
/// The kit is Anthropic's, published under "all rights reserved", so it is
/// never carried inside this product; it is fetched onto the reader's own
/// machine instead. It used to be fetched by shelling out to `npm ci`, which
/// made npm a thing the reader had to install by hand. Now the fetch is done
/// here, over the network, from the lock this build carries: every package the
/// lock names is downloaded from where the lock says it lives and checked
/// against the fingerprint the lock records, so the reader needs no npm at all
/// (bw-oesd.2).
///
/// Guarded by that same lock, so it is paid once per machine and again only
/// when the lock changes. The packages the lock marks development-only or
/// optional are left behind, which is what `npm ci --omit=dev --omit=optional`
/// did before: the type declarations nothing reads at run time, and the
/// platform copies of Claude Code the reader already has.
pub async fn fetch_kit(package: &Path) -> Result<(), String> {
    let lock = std::fs::read(package.join("package-lock.json"))
        .map_err(|e| format!("{}: {e}", package.join("package-lock.json").display()))?;
    let want = crate::laid_down::fingerprint(&vec![("package-lock.json".to_string(), lock)]);

    if already_fetched(package, &want) {
        return Ok(());
    }

    fetch_locked_packages(package).await?;

    if !package.join(KIT).exists() {
        return Err(format!("the chat's kit was fetched but {KIT} is not there"));
    }
    crate::laid_down::write_marker(package, KIT_MARKER, &want)
}

/// Download and lay down every package the lock names, into the tree it names.
///
/// A version-3 lock lists each installed package under the exact path it goes
/// in, from `node_modules/<name>` down to the nested
/// `node_modules/<a>/node_modules/<b>` a duplicated version lands in. Each
/// entry says where its tarball lives (`resolved`) and what it must hash to
/// (`integrity`). Walking those entries and fetching each in turn is all the
/// install a run-time kit needs: there is no dependency resolving left to do,
/// the lock already did it.
async fn fetch_locked_packages(package: &Path) -> Result<(), String> {
    let lock_path = package.join("package-lock.json");
    let text =
        std::fs::read_to_string(&lock_path).map_err(|e| format!("{}: {e}", lock_path.display()))?;
    let lock: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not readable as a lock: {e}", lock_path.display()))?;
    let packages = lock
        .get("packages")
        .and_then(|p| p.as_object())
        .ok_or_else(|| format!("{} names no packages to fetch", lock_path.display()))?;

    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("a fetcher for the chat's kit could not be built: {e}"))?;

    for (where_it_goes, entry) in packages {
        // The root of the tree is the helper itself, not a package to fetch.
        if !where_it_goes.starts_with("node_modules/") {
            continue;
        }
        // What `npm ci --omit=dev --omit=optional` left behind: development-only
        // type declarations, and the platform binaries the reader already has.
        if entry.get("dev").and_then(|d| d.as_bool()) == Some(true)
            || entry.get("optional").and_then(|o| o.as_bool()) == Some(true)
        {
            continue;
        }
        // A package with no tarball to fetch, a workspace link say, is nothing
        // to download; the lock points such an entry at a folder, not a URL.
        let Some(resolved) = entry.get("resolved").and_then(|r| r.as_str()) else {
            continue;
        };
        if !(resolved.starts_with("http://") || resolved.starts_with("https://")) {
            continue;
        }
        let integrity = entry
            .get("integrity")
            .and_then(|i| i.as_str())
            .ok_or_else(|| {
                format!("the lock names {where_it_goes} but no fingerprint to check it by")
            })?;
        fetch_one_package(&client, resolved, integrity, &package.join(where_it_goes))
            .await
            .map_err(|e| format!("the chat's kit could not be fetched ({where_it_goes}): {e}"))?;
    }
    Ok(())
}

/// Fetch one package's tarball, prove it is the one the lock named, and unpack
/// it where the lock said it goes.
async fn fetch_one_package(
    client: &reqwest::Client,
    url: &str,
    integrity: &str,
    dest: &Path,
) -> Result<(), String> {
    let answer =
        client.get(url).send().await.map_err(|e| {
            format!("{url}: {e}. Fetching the kit needs the network the first time")
        })?;
    if !answer.status().is_success() {
        return Err(format!("{url} answered {}", answer.status()));
    }
    let bytes = answer.bytes().await.map_err(|e| format!("{url}: {e}"))?;
    verify_integrity(&bytes, integrity)?;

    // gzip-decoding and un-taring are blocking work; kept off the async runtime
    // so the board this shares a process with keeps answering while the kit
    // lands.
    let bytes = bytes.to_vec();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || unpack_package(&bytes, &dest))
        .await
        .map_err(|e| format!("unpacking was interrupted: {e}"))?
}

/// Prove a downloaded tarball is byte-for-byte the one the lock recorded.
///
/// The lock records a Subresource-Integrity string, `sha512-<base64>`, and
/// sometimes several separated by spaces. A modern lock always carries a
/// sha512; that is the one checked, because a weaker digest beside it would
/// only weaken the proof.
fn verify_integrity(bytes: &[u8], integrity: &str) -> Result<(), String> {
    use sha2::{Digest, Sha512};
    let recorded = integrity
        .split_whitespace()
        .find_map(|token| token.strip_prefix("sha512-"))
        .ok_or_else(|| format!("no sha512 fingerprint in {integrity:?} to check against"))?;
    let want = base64::engine::general_purpose::STANDARD
        .decode(recorded)
        .map_err(|e| format!("the recorded fingerprint {recorded:?} is not readable: {e}"))?;
    let got = Sha512::digest(bytes);
    if got.as_slice() != want.as_slice() {
        return Err(
            "what was fetched does not match the fingerprint the lock recorded".to_string(),
        );
    }
    Ok(())
}

/// Un-tar one npm tarball into `dest`, dropping the wrapping `package/` folder.
///
/// Every npm tarball is a gzipped tar whose files all sit under a single
/// top-level `package/` directory; `dest` is where that directory's contents
/// belong. Any entry that tries to climb out of `dest` with `..` or an absolute
/// path is refused rather than followed, so a bad tarball cannot write outside
/// the folder it was given.
fn unpack_package(gzipped_tar: &[u8], dest: &Path) -> Result<(), String> {
    use std::path::Component;
    let decoder = flate2::read::GzDecoder::new(gzipped_tar);
    let mut archive = tar::Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|e| format!("the tarball could not be read: {e}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| format!("a file in the tarball could not be read: {e}"))?;
        let named = entry
            .path()
            .map_err(|e| format!("a file in the tarball has an unreadable name: {e}"))?
            .into_owned();
        // Drop the leading `package/` component.
        let mut parts = named.components();
        parts.next();
        let relative = parts.as_path();
        if relative.as_os_str().is_empty() {
            continue;
        }
        if relative.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(format!(
                "the tarball holds an unsafe path: {}",
                named.display()
            ));
        }
        let out = dest.join(relative);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        entry
            .unpack(&out)
            .map_err(|e| format!("{}: {e}", out.display()))?;
    }
    Ok(())
}

/// Whether the kit in `package` is the one `want` names.
///
/// Both halves are needed. The marker alone would trust a folder somebody
/// cleaned out, or an install that was interrupted half way; the file alone
/// would keep a kit fetched against a lock this build has moved past.
fn already_fetched(package: &Path, want: &str) -> bool {
    package.join(KIT).exists() && crate::laid_down::marker_says(package, KIT_MARKER, want)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a package tarball the way npm publishes one: a gzipped tar whose
    /// files all sit under a single `package/` folder. Returns the bytes and
    /// the Subresource-Integrity string the lock would record for them.
    fn make_tarball(files: &[(&str, &[u8])]) -> (Vec<u8>, String) {
        use sha2::{Digest, Sha512};
        use std::io::Write;
        let mut tarred = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tarred);
            for (path, content) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                builder.append_data(&mut header, path, *content).unwrap();
            }
            builder.finish().unwrap();
        }
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tarred).unwrap();
        let gzipped = encoder.finish().unwrap();
        let integrity = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(Sha512::digest(&gzipped))
        );
        (gzipped, integrity)
    }

    /// Serve some already-built tarballs over loopback and return the address.
    async fn serve_tarballs(routes: Vec<(&'static str, Vec<u8>)>) -> std::net::SocketAddr {
        use axum::{routing::get, Router};
        use std::sync::Arc;
        let mut app = Router::new();
        for (path, body) in routes {
            let body = Arc::new(body);
            app = app.route(
                path,
                get(move || {
                    let body = body.clone();
                    async move { body.to_vec() }
                }),
            );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        address
    }

    #[tokio::test]
    async fn the_kit_and_its_tree_are_fetched_from_the_lock_and_laid_down() {
        // The whole locked tree is fetched, not just the top package: the kit
        // and a nested dependency of it both land where node looks for them,
        // and the entries the lock marks development-only or optional are left
        // behind exactly as `npm ci --omit=dev --omit=optional` would leave them
        // (their tarballs are never even served here).
        let (sdk_tar, sdk_integrity) =
            make_tarball(&[("package/sdk.mjs", b"export const kit = true;\n")]);
        let (dep_tar, dep_integrity) =
            make_tarball(&[("package/index.js", b"module.exports = 1;\n")]);
        let address = serve_tarballs(vec![("/sdk.tgz", sdk_tar), ("/dep.tgz", dep_tar)]).await;

        let temporary = tempfile::tempdir().unwrap();
        let package = temporary.path();
        let lock = serde_json::json!({
            "name": "workbench",
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "workbench" },
                "node_modules/@anthropic-ai/claude-agent-sdk": {
                    "version": "0.3.232",
                    "resolved": format!("http://{address}/sdk.tgz"),
                    "integrity": sdk_integrity,
                },
                "node_modules/@anthropic-ai/claude-agent-sdk/node_modules/leftpad": {
                    "version": "1.0.0",
                    "resolved": format!("http://{address}/dep.tgz"),
                    "integrity": dep_integrity,
                },
                "node_modules/@types/node": {
                    "version": "20.0.0",
                    "dev": true,
                    "resolved": "http://127.0.0.1:9/never.tgz",
                    "integrity": "sha512-AAAAAAAA",
                },
                "node_modules/fsevents": {
                    "version": "2.3.0",
                    "optional": true,
                    "resolved": "http://127.0.0.1:9/never.tgz",
                    "integrity": "sha512-AAAAAAAA",
                },
            }
        });
        std::fs::write(
            package.join("package-lock.json"),
            serde_json::to_vec(&lock).unwrap(),
        )
        .unwrap();

        fetch_locked_packages(package).await.unwrap();

        assert!(
            package.join(KIT).exists(),
            "the kit's sdk.mjs did not land where node looks for it"
        );
        assert_eq!(
            std::fs::read(package.join(KIT)).unwrap(),
            b"export const kit = true;\n"
        );
        assert!(
            package
                .join("node_modules/@anthropic-ai/claude-agent-sdk/node_modules/leftpad/index.js")
                .exists(),
            "the kit's own dependency was not fetched, so the tree is not walked"
        );
        assert!(
            !package.join("node_modules/@types/node").exists(),
            "a development-only package was fetched and should not have been"
        );
        assert!(
            !package.join("node_modules/fsevents").exists(),
            "an optional package was fetched and should not have been"
        );
    }

    #[tokio::test]
    async fn a_tarball_that_does_not_match_the_locks_fingerprint_is_refused() {
        // The fetch checks every tarball against the fingerprint the lock
        // recorded. Here the server hands back a real, valid tarball, but the
        // lock records the fingerprint of a different one, so the fetch must
        // fail and nothing must be laid down.
        let (served_tar, _its_own_integrity) =
            make_tarball(&[("package/sdk.mjs", b"the bytes actually served\n")]);
        let (_other_tar, someone_elses_integrity) =
            make_tarball(&[("package/sdk.mjs", b"bytes the lock was told to expect\n")]);
        let address = serve_tarballs(vec![("/sdk.tgz", served_tar)]).await;

        let temporary = tempfile::tempdir().unwrap();
        let package = temporary.path();
        let lock = serde_json::json!({
            "lockfileVersion": 3,
            "packages": {
                "": { "name": "workbench" },
                "node_modules/@anthropic-ai/claude-agent-sdk": {
                    "version": "0.3.232",
                    "resolved": format!("http://{address}/sdk.tgz"),
                    "integrity": someone_elses_integrity,
                },
            }
        });
        std::fs::write(
            package.join("package-lock.json"),
            serde_json::to_vec(&lock).unwrap(),
        )
        .unwrap();

        let outcome = fetch_locked_packages(package).await;
        assert!(
            outcome.is_err(),
            "a tarball whose hash does not match the lock must be refused"
        );
        assert!(
            !package.join(KIT).exists(),
            "nothing must be laid down from a tarball that failed its check"
        );
    }

    #[tokio::test]
    async fn presentation_files_go_to_the_running_app_instead_of_its_data_directory() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc, Mutex};

        let seen = Arc::new(Mutex::new(None));
        let received = seen.clone();
        let app = Router::new().route(
            "/api/workbench/present",
            post(move |Json(body): Json<serde_json::Value>| {
                *received.lock().unwrap() = Some(body);
                async { Json(serde_json::json!({ "output": "validated transcript\n" })) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let temporary = tempfile::tempdir().unwrap();
        let image = temporary.path().join("agent-picture.png");
        std::fs::write(&image, b"temporary bytes").unwrap();
        let args = vec![
            "image".to_string(),
            "--file".to_string(),
            image.display().to_string(),
            "--alt".to_string(),
            "Proof".to_string(),
        ];
        let output = present_to(&args, String::new(), &format!("http://{address}"))
            .await
            .unwrap();

        assert_eq!(output, "validated transcript\n");
        let request = seen.lock().unwrap().take().unwrap();
        let uploaded = request["files"][image.display().to_string()]
            .as_str()
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(uploaded)
                .unwrap(),
            b"temporary bytes"
        );
    }

    #[tokio::test]
    async fn screen_check_files_go_to_the_running_app_and_return_its_manifest() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc, Mutex};

        let seen = Arc::new(Mutex::new(None));
        let received = seen.clone();
        let app = Router::new().route(
            "/api/workbench/screen-check",
            post(move |Json(body): Json<serde_json::Value>| {
                *received.lock().unwrap() = Some(body);
                async { Json(serde_json::json!({ "result": { "check_id": "check_123", "captures": [] } })) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let temporary = tempfile::tempdir().unwrap();
        let image = temporary.path().join("temporary.png");
        std::fs::write(&image, b"temporary bytes").unwrap();
        let args = vec![
            "capture".to_string(),
            "--type".to_string(),
            "image".to_string(),
            "--target".to_string(),
            image.display().to_string(),
        ];
        let output = screen_check_to(&args, &format!("http://{address}"))
            .await
            .unwrap();

        assert_eq!(output["check_id"], "check_123");
        let request = seen.lock().unwrap().take().unwrap();
        let uploaded = request["files"][image.display().to_string()]
            .as_str()
            .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(uploaded)
                .unwrap(),
            b"temporary bytes"
        );
    }

    #[test]
    fn screen_check_does_not_treat_a_web_target_as_a_local_file() {
        let args = vec![
            "capture".to_string(),
            "--type".to_string(),
            "web".to_string(),
            "--target".to_string(),
            "https://example.test/screen".to_string(),
        ];
        let request = screen_check_request(&args).unwrap();
        assert!(request.files.is_empty());
    }

    #[test]
    fn the_build_carries_the_file_that_gets_started() {
        let names: Vec<String> = Helper::iter().map(|n| n.to_string()).collect();
        assert!(
            names.iter().any(|n| n == "src/server.ts"),
            "the helper's entry is not in this build; it carries {names:?}"
        );
        for driver in [
            "src/drivers/claude.ts",
            "src/drivers/codex.ts",
            "src/drivers/index.ts",
        ] {
            assert!(names.iter().any(|n| n == driver), "{driver} is not carried");
        }
    }

    #[test]
    fn the_build_carries_what_says_which_kit_to_fetch() {
        let names: Vec<String> = Helper::iter().map(|n| n.to_string()).collect();
        for needed in ["package.json", "package-lock.json"] {
            assert!(
                names.iter().any(|n| n == needed),
                "{needed} is not carried; it has {names:?}"
            );
        }
    }

    #[test]
    fn nothing_written_for_this_repository_is_carried() {
        for name in Helper::iter() {
            assert!(
                !name.contains("__tests__"),
                "{name} is a test of ours, not part of the helper"
            );
        }
        for name in Shared::iter() {
            assert!(
                !name.contains("__tests__"),
                "{name} is a test of ours, not part of the helper"
            );
        }
    }

    #[test]
    fn the_build_carries_every_shared_module_the_helper_reads() {
        let names: Vec<String> = Shared::iter().map(|n| n.to_string()).collect();
        // What `workbench/src` imports out of `src/workbench` today. Named one
        // by one so a module going missing is a red test here rather than a
        // dead Chat tab on somebody else's computer.
        for needed in [
            "chat-state.ts",
            "context-window.ts",
            "fold.ts",
            "imported-history.ts",
            "link-rules.ts",
            "machine-words.ts",
            "message-filter.ts",
            "plan-usage.ts",
            "protocol.ts",
            "running.ts",
            "token-picture.ts",
            "window-now.ts",
            "chat-widgets.ts",
        ] {
            assert!(
                names.iter().any(|n| n == needed),
                "{needed} is not carried; it has {names:?}"
            );
        }
    }

    #[test]
    fn no_screen_is_carried_into_a_program_with_no_browser() {
        for name in Shared::iter() {
            assert!(
                !name.ends_with(".tsx"),
                "{name} is a screen, not something the helper runs"
            );
        }
    }

    #[test]
    fn nothing_of_anthropics_own_travels_inside_this_product() {
        // The kit is published under "all rights reserved", so a copy of it in
        // here would be us redistributing somebody else's program. It is
        // fetched on the reader's machine instead.
        for name in Helper::iter().chain(Shared::iter()) {
            assert!(
                !name.contains("node_modules"),
                "{name} is somebody else's package, and this build must not carry one"
            );
        }
    }

    #[test]
    fn the_kit_is_fetched_where_node_looks_for_it_from_the_file_that_gets_started() {
        // `node` resolving a package from `<helper>/workbench/src/server.ts`
        // walks up: `workbench/src/node_modules`, then `workbench/node_modules`.
        // The second is the package folder the kit is fetched into, and this
        // says so in the one place a change to either constant would break it
        // silently.
        let entry = PathBuf::from(ENTRY);
        let from = entry.parent().expect("the entry is inside a folder");
        assert_eq!(
            from.parent()
                .expect("and that folder is inside the package"),
            Path::new(PACKAGE)
        );
        assert!(KIT.starts_with("node_modules/"));
    }

    #[test]
    fn the_shared_modules_sit_where_the_helper_reaches_for_them() {
        // `workbench/src/drivers/claude.ts` names them
        // `../../../src/workbench/protocol.ts`, so three steps up from the
        // driver's own folder has to land where they are laid down.
        let driver = PathBuf::from("workbench/src/drivers/claude.ts");
        let mut up = driver
            .parent()
            .expect("the driver is inside a folder")
            .to_path_buf();
        for _ in 0..3 {
            up = up
                .parent()
                .expect("and there is somewhere above it")
                .to_path_buf();
        }
        assert_eq!(up.join("src/workbench"), PathBuf::from("src/workbench"));
    }

    /// A folder with a kit in it, fetched against `marker`.
    fn fetched(dir: &Path, marker: &str) {
        std::fs::create_dir_all(dir.join(KIT).parent().unwrap()).unwrap();
        std::fs::write(dir.join(KIT), b"the kit").unwrap();
        crate::laid_down::write_marker(dir, KIT_MARKER, marker).unwrap();
    }

    #[test]
    fn a_kit_already_fetched_against_this_lock_is_not_fetched_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        fetched(dir.path(), "this lock");
        assert!(already_fetched(dir.path(), "this lock"));
    }

    #[test]
    fn a_kit_fetched_against_an_older_lock_is_fetched_again() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        fetched(dir.path(), "an older lock");
        assert!(!already_fetched(dir.path(), "this lock"));
    }

    #[test]
    fn a_folder_with_no_kit_in_it_is_fetched_into_however_the_marker_reads() {
        // The marker says this lock was already fetched, but the kit is not
        // there — an install that was interrupted, or a folder somebody
        // cleaned out. Starting a helper that cannot import anything is worse
        // than paying the fetch again.
        let dir = tempfile::tempdir().expect("a temporary directory");
        crate::laid_down::write_marker(dir.path(), KIT_MARKER, "this lock").unwrap();
        assert!(!already_fetched(dir.path(), "this lock"));
    }

    #[test]
    fn a_folder_nothing_has_ever_been_fetched_into_is_fetched_into() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        assert!(!already_fetched(dir.path(), "this lock"));
    }
}
