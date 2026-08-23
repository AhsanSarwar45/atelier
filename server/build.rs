//! What the product carries, told to cargo.
//!
//! The screens, the working rules, the craft beside them, the report tools and
//! the chat helper are all read out of these folders while this crate compiles,
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

fn main() {
    for carried in [
        "../out",             // the screens
        "../machinery",       // the working rules
        "../.claude",         // the craft beside them
        "../reporting/tools", // the tools that build a report
        "../workbench",       // the chat helper
        "../src/workbench",   // the helper's own screens
    ] {
        println!("cargo:rerun-if-changed={carried}");
    }
}
