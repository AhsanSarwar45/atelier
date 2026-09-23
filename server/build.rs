//! What the product carries, told to cargo.
//!
//! The screens, the working rules, the craft beside them, the report tools and
//! the native chat implementation is compiled with the server, while these external folders
//! and travel inside the binary. Cargo cannot see that on its own: it watches
//! this crate's own source and nothing else, so a build after a change to any
//! of these folders was answered with the previous binary, and the installed
//! program went on serving the screens and the rules of the build before
//! (bw-8um.3.1).
//!
//! Named as folders, so a file appearing or going away counts as a change and
//! not only a file being edited. The cost is an occasional rebuild nobody asked
//! for — python leaves a cache beside the tools when one of them is first run,
//! and a local settings file lives under the craft — which is the cheap way
//! round: the other way ships last week's rules and says nothing.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::{write::GzEncoder, Compression};

fn main() {
    for carried in [
        "../out",             // the screens
        "../machinery",       // the working rules
        "../.claude",         // the craft beside them
        "../reporting/tools", // the tools that build a report
    ] {
        println!("cargo:rerun-if-changed={carried}");
    }
    screens();
}

/// The screens as they are carried: every file that shrinks is gzipped once
/// here and stored as `<name>.gz`, and everything else is stored as it is.
///
/// Carrying them compressed does two things at once. The binary holds a
/// fraction of the bytes, and a browser on another computer is sent those same
/// bytes as they sit, with no compression work per request and no copy made
/// (bw-fbzd.2). The rare client that cannot take gzip is answered by unpacking
/// the file on the way out.
fn screens() {
    let source = Path::new("../out");
    let target =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("cargo sets OUT_DIR")).join("screens");
    let _ = fs::remove_dir_all(&target);
    fs::create_dir_all(&target).expect("the screens folder can be made");
    if source.is_dir() {
        carry(source, source, &target);
    }
}

fn carry(root: &Path, dir: &Path, target: &Path) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .expect("the screens can be listed")
        .flatten()
        .collect();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            carry(root, &path, target);
            continue;
        }
        let relative = path.strip_prefix(root).expect("inside the screens");
        let out = target.join(relative);
        fs::create_dir_all(out.parent().expect("a file has a folder"))
            .expect("the folder can be made");
        let bytes = fs::read(&path).expect("a screen file can be read");
        if shrinks(&path) {
            let mut encoder =
                GzEncoder::new(Vec::with_capacity(bytes.len() / 3), Compression::best());
            encoder.write_all(&bytes).expect("gzip in memory");
            let packed = encoder.finish().expect("gzip in memory");
            if packed.len() < bytes.len() {
                let mut name = out.into_os_string();
                name.push(".gz");
                fs::write(name, packed).expect("the packed screen can be written");
                continue;
            }
        }
        fs::write(out, bytes).expect("the screen can be written");
    }
}

/// Formats that are already compressed gain nothing from a second pass.
fn shrinks(path: &Path) -> bool {
    !matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some(
            "woff2"
                | "woff"
                | "png"
                | "jpg"
                | "jpeg"
                | "gif"
                | "webp"
                | "avif"
                | "mp4"
                | "webm"
                | "gz"
                | "br"
                | "zip"
        )
    )
}
