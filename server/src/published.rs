//! The fingerprints a release publishes for its own files, and a download that
//! is kept only if it matches one.
//!
//! Every release publishes `SHA256SUMS.txt` beside its files: the build writes
//! it with `sha256sum *` (`.github/workflows/release.yml`), and
//! `scripts/tap.sh` already reads it to fingerprint the Homebrew recipe. This
//! is the same reading, done by the app for the files the app fetches for
//! itself — the replacement binary today, and whatever else it learns to fetch
//! later. Nothing here knows about the updater, so the next downloader can use
//! it without going through one.
//!
//! The rule is that bytes are proved before they are kept, not after they are
//! run: the hash is taken as the bytes stream past on their way to disk, and a
//! file that does not match is deleted where it lies. Whatever was already on
//! disk is never touched, because a download is always written beside it under
//! its own name and only moved into place by whoever asked for it.

use futures::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// The file a release publishes its fingerprints in.
pub const CHECKSUMS_ASSET: &str = "SHA256SUMS.txt";

/// Why a download did not end as a proved file on disk.
///
/// Every variant carries the sentence to show the person who asked for it: a
/// download that is refused says so and says why, rather than stopping quietly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unproved {
    /// The release publishes no fingerprint for this file, so there is nothing
    /// to prove it against.
    NotPublished(String),
    /// What arrived is not what we published.
    DoesNotMatch(String),
    /// The download, or the writing of it, did not finish.
    Interrupted(String),
}

impl Unproved {
    /// The sentence to show the reader.
    pub fn reason(&self) -> &str {
        match self {
            Unproved::NotPublished(r) | Unproved::DoesNotMatch(r) | Unproved::Interrupted(r) => r,
        }
    }

    /// Whether the file was turned away rather than merely lost on the way.
    ///
    /// A refusal is a statement about the bytes — the release does not vouch
    /// for them, or they are not the ones it vouched for. An interruption says
    /// nothing about them at all, and is worth another try.
    pub fn is_refusal(&self) -> bool {
        !matches!(self, Unproved::Interrupted(_))
    }
}

impl std::fmt::Display for Unproved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason())
    }
}

/// The fingerprint `list` publishes for `file`, if it publishes one.
///
/// The build writes the list with `sha256sum *`, so each line is
/// "<fingerprint>  <file>" — the same reading `scripts/tap.sh` does, and the
/// only one this project has.
pub fn checksum_for(list: &str, file: &str) -> Option<String> {
    list.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let found = fields.next()?;
        (fields.next()? == file).then(|| found.to_string())
    })
}

/// Reads the fingerprints a release publishes, from the release's own copy.
pub async fn checksums(
    client: &reqwest::Client,
    checksums_url: &str,
) -> Result<String, Unproved> {
    let response = client.get(checksums_url).send().await.map_err(|e| {
        Unproved::Interrupted(format!("Could not read the published checksums: {}", e))
    })?;
    if !response.status().is_success() {
        return Err(Unproved::Interrupted(format!(
            "Could not read the published checksums: HTTP {}",
            response.status()
        )));
    }
    response.text().await.map_err(|e| {
        Unproved::Interrupted(format!("Could not read the published checksums: {}", e))
    })
}

/// Writes `stream` to `dest`, hashing it as it goes, and keeps the file only if
/// it hashes to `published`.
///
/// The bytes are hashed on their way past, so nothing bigger than one chunk of
/// the download is ever held in memory. If anything goes wrong — a stalled
/// download, a failed write, a fingerprint that does not match — the part that
/// was written is removed before returning, so nothing is left behind for
/// anything else to pick up and run.
pub async fn write_if_it_matches<S, B, E>(
    stream: S,
    published: &str,
    file: &str,
    dest: &Path,
) -> Result<u64, Unproved>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let outcome = hash_into(stream, dest).await;
    let (written, found) = match outcome {
        Ok(both) => both,
        Err(e) => {
            let _ = tokio::fs::remove_file(dest).await;
            return Err(e);
        }
    };

    if !found.eq_ignore_ascii_case(published) {
        let _ = tokio::fs::remove_file(dest).await;
        return Err(Unproved::DoesNotMatch(format!(
            "Refused: the downloaded {} is not the one we published. \
             Its checksum is {}, and the release publishes {}. \
             Nothing was replaced and the download was deleted.",
            file, found, published
        )));
    }

    Ok(written)
}

/// Streams into `dest`, returning how much was written and what it hashed to.
async fn hash_into<S, B, E>(stream: S, dest: &Path) -> Result<(u64, String), Unproved>
where
    S: Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| Unproved::Interrupted(format!("Failed to write download: {}", e)))?;

    let mut hasher = Sha256::new();
    let mut written: u64 = 0;
    let mut stream = std::pin::pin!(stream);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| Unproved::Interrupted(format!("Download failed part way: {}", e)))?;
        let chunk = chunk.as_ref();
        hasher.update(chunk);
        file.write_all(chunk)
            .await
            .map_err(|e| Unproved::Interrupted(format!("Failed to write download: {}", e)))?;
        written += chunk.len() as u64;
    }

    file.flush()
        .await
        .map_err(|e| Unproved::Interrupted(format!("Failed to write download: {}", e)))?;

    Ok((written, format!("{:x}", hasher.finalize())))
}

/// Downloads `asset_url` to `dest`, proving it against the fingerprint the same
/// release publishes for `file`.
///
/// `checksums_url` must come from the same release as `asset_url` — read off
/// one answer from the releases API, so there is no window in which the two
/// could describe different releases.
///
/// A release that publishes no `SHA256SUMS.txt` is refused. Releases made
/// before the build started publishing the file cannot be proved at all, and
/// "we could not check" is not a reason to run somebody else's bytes: the whole
/// point of the check is that the app does not decide, alone and offline,
/// whether an unproved binary is fine this once. A person who wants an
/// unprovable release can still fetch it deliberately from the release page.
pub async fn download(
    client: &reqwest::Client,
    asset_url: &str,
    checksums_url: Option<&str>,
    file: &str,
    dest: &Path,
) -> Result<u64, Unproved> {
    let checksums_url = match checksums_url {
        Some(url) => url,
        None => {
            return Err(Unproved::NotPublished(format!(
                "Refused: this release publishes no {}, so the download cannot be \
                 proved to be the one we released. Nothing was replaced.",
                CHECKSUMS_ASSET
            )))
        }
    };

    let list = checksums(client, checksums_url).await?;
    let published = match checksum_for(&list, file) {
        Some(f) => f,
        None => {
            return Err(Unproved::NotPublished(format!(
                "Refused: the release's {} lists no checksum for {}, so the download \
                 cannot be proved to be the one we released. Nothing was replaced.",
                CHECKSUMS_ASSET, file
            )))
        }
    };

    let response = client
        .get(asset_url)
        .send()
        .await
        .map_err(|e| Unproved::Interrupted(format!("Download failed: {}", e)))?;
    if !response.status().is_success() {
        return Err(Unproved::Interrupted(format!(
            "Download failed: HTTP {}",
            response.status()
        )));
    }

    write_if_it_matches(response.bytes_stream(), &published, file, dest).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The list the build writes: `sha256sum *`, two spaces between.
    const LIST: &str = "\
1e0b2f0a0a5c1e3b6c2f4a7d9e8b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b  atelier-darwin-arm64
2f1c3a1b1b6d2f4c7d3a5b8e0f9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c  atelier-linux-x64
3a2d4b2c2c7e3a5d8e4b6c9f1a0d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d  atelier-win-x64.exe
";

    fn sha256_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    /// One download's worth of chunks, as the network would hand them over.
    fn arriving(chunks: Vec<&'static [u8]>) -> impl Stream<Item = Result<&'static [u8], String>> {
        futures::stream::iter(chunks.into_iter().map(Ok))
    }

    // ── reading the published list ──────────────────────────────────────

    #[test]
    fn test_checksum_for_finds_each_file() {
        assert_eq!(
            checksum_for(LIST, "atelier-linux-x64").as_deref(),
            Some("2f1c3a1b1b6d2f4c7d3a5b8e0f9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c")
        );
        assert_eq!(
            checksum_for(LIST, "atelier-win-x64.exe").as_deref(),
            Some("3a2d4b2c2c7e3a5d8e4b6c9f1a0d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d")
        );
    }

    #[test]
    fn test_checksum_for_unlisted_file_is_none() {
        assert!(checksum_for(LIST, "atelier-freebsd-x64").is_none());
    }

    #[test]
    fn test_checksum_for_does_not_match_on_a_prefix() {
        // "atelier-linux" is not "atelier-linux-x64", and a fingerprint taken
        // from a near-miss would prove the wrong file.
        assert!(checksum_for(LIST, "atelier-linux").is_none());
    }

    #[test]
    fn test_checksum_for_ignores_a_fingerprint_in_the_wrong_column() {
        // A name that only ever appears as a fingerprint is not a file.
        assert!(checksum_for(LIST, "2f1c3a1b1b6d2f4c7d3a5b8e0f9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c").is_none());
    }

    // ── a download that matches ─────────────────────────────────────────

    #[tokio::test]
    async fn test_a_matching_download_is_written() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let dest = dir.path().join("atelier-new");
        let published = sha256_of(b"the release we published");

        let written = write_if_it_matches(
            arriving(vec![b"the release ", b"we published"]),
            &published,
            "atelier-linux-x64",
            &dest,
        )
        .await
        .expect("a matching download is kept");

        assert_eq!(written, b"the release we published".len() as u64);
        assert_eq!(
            std::fs::read(&dest).expect("read the kept download"),
            b"the release we published"
        );
    }

    // ── a download that does not match ──────────────────────────────────

    #[tokio::test]
    async fn test_a_download_that_does_not_match_is_refused() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let dest = dir.path().join("atelier-new");
        let published = sha256_of(b"the release we published");

        let outcome = write_if_it_matches(
            arriving(vec![b"somebody ", b"else's bytes"]),
            &published,
            "atelier-linux-x64",
            &dest,
        )
        .await;

        let refusal = outcome.expect_err("a download that does not match must be refused");
        assert!(
            matches!(refusal, Unproved::DoesNotMatch(_)),
            "the refusal must say the checksum did not match, got: {refusal:?}"
        );
        assert!(refusal.is_refusal(), "a mismatch is a refusal, not a hiccup");
        assert!(
            refusal.reason().contains("atelier-linux-x64")
                && refusal.reason().contains(&published),
            "the reason must name the file and the published checksum, got: {}",
            refusal.reason()
        );
        assert!(
            !dest.exists(),
            "a refused download must not be left on disk at {}",
            dest.display()
        );
    }

    #[tokio::test]
    async fn test_a_refused_download_leaves_the_existing_binary_in_place() {
        let dir = tempfile::tempdir().expect("create temp dir");
        // The program that is running now, beside where its replacement lands.
        let running = dir.path().join("atelier");
        std::fs::write(&running, b"the program that is running").expect("write running binary");
        let dest = dir.path().join("atelier-new");
        let published = sha256_of(b"the release we published");

        let refusal = write_if_it_matches(
            arriving(vec![b"somebody else's bytes"]),
            &published,
            "atelier-linux-x64",
            &dest,
        )
        .await
        .expect_err("a download that does not match must be refused");

        assert_eq!(
            std::fs::read(&running).expect("read running binary"),
            b"the program that is running",
            "the running program must be exactly as it was"
        );
        assert!(!dest.exists(), "the part that was written must be gone");
        assert!(
            !refusal.reason().is_empty(),
            "a refusal must come with a reason to show"
        );
        assert!(
            refusal.reason().to_lowercase().contains("refused"),
            "the reason must say the download was refused, got: {}",
            refusal.reason()
        );
    }

    #[tokio::test]
    async fn test_a_download_that_stops_part_way_leaves_nothing_behind() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let dest = dir.path().join("atelier-new");
        let published = sha256_of(b"the release we published");

        let arriving = futures::stream::iter(vec![
            Ok(b"the release ".as_slice()),
            Err("the connection was cut".to_string()),
        ]);

        let stopped = write_if_it_matches(arriving, &published, "atelier-linux-x64", &dest)
            .await
            .expect_err("an interrupted download cannot be kept");

        assert!(
            matches!(stopped, Unproved::Interrupted(_)),
            "a cut connection is an interruption, not a refusal: {stopped:?}"
        );
        assert!(!stopped.is_refusal(), "an interruption is worth another try");
        assert!(!dest.exists(), "the part that was written must be gone");
    }

    // ── a release with nothing to prove against ─────────────────────────

    #[tokio::test]
    async fn test_a_release_without_a_checksums_file_is_refused() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let dest = dir.path().join("atelier-new");
        let client = reqwest::Client::new();

        let refusal = download(
            &client,
            "https://example.invalid/atelier-linux-x64",
            None,
            "atelier-linux-x64",
            &dest,
        )
        .await
        .expect_err("a release that publishes no checksums must be refused");

        assert!(
            matches!(refusal, Unproved::NotPublished(_)),
            "the refusal must say nothing was published to check against: {refusal:?}"
        );
        assert!(
            refusal.reason().contains(CHECKSUMS_ASSET),
            "the reason must name the missing file, got: {}",
            refusal.reason()
        );
        assert!(
            !dest.exists(),
            "nothing may be downloaded before there is something to prove it against"
        );
    }
}
