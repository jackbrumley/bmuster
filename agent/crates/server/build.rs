//! Build-time facts the server launcher and updater carry:
//!
//! * `BMUSTER_TARGET`: the target triple; the updater installs only releases
//!   for it.
//! * `BMUSTER_EXTRA_RELEASE_KEY`: one more trusted release key, only when the
//!   variable of that name is set at build time (development builds and
//!   self-builders), as for the agent. Empty otherwise, so a release build
//!   trusts only the project key in `../agent/release-key.pub`.
fn main() {
    println!(
        "cargo:rustc-env=BMUSTER_TARGET={}",
        std::env::var("TARGET").expect("Cargo target")
    );
    let extra = std::env::var("BMUSTER_EXTRA_RELEASE_KEY").unwrap_or_default();
    println!("cargo:rustc-env=BMUSTER_EXTRA_RELEASE_KEY={}", extra.trim());
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../agent/release-key.pub");
    println!("cargo:rerun-if-env-changed=BMUSTER_EXTRA_RELEASE_KEY");
}
