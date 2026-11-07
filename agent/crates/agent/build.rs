//! Build-time facts the agent carries (SPEC-ENROLMENT, SPEC-AGENT-UPDATES):
//!
//! * `BMUSTER_TARGET`: the target triple, so enrolment can name this build.
//! * `BMUSTER_VERSION`: the version this build reports and updates by. Set it
//!   to give a build its own version (`npm run agent:release-local` uses
//!   `0.1.0-dev.<UTC time>`, release builds the tag); otherwise Cargo's.
//! * `BMUSTER_RELEASE_KEY`: the project's release public key, from
//!   `release-key.pub`. Official builds are signed with its private half.
//! * `BMUSTER_EXTRA_RELEASE_KEY`: one more trusted release key, only when the
//!   variable of that name is set at build time (development builds and
//!   self-builders). Empty otherwise, so a release build trusts only the
//!   project key.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

fn main() {
    let target = std::env::var("TARGET").expect("cargo sets TARGET for build scripts");
    println!("cargo:rustc-env=BMUSTER_TARGET={target}");

    let version = match std::env::var("BMUSTER_VERSION") {
        Ok(text) if !text.is_empty() => text,
        _ => std::env::var("CARGO_PKG_VERSION").expect("cargo sets CARGO_PKG_VERSION"),
    };
    if let Err(e) = bmuster_protocol::AgentVersion::parse(&version) {
        panic!("BMUSTER_VERSION: {e}");
    }
    println!("cargo:rustc-env=BMUSTER_VERSION={version}");

    let release_key = std::fs::read_to_string("release-key.pub")
        .expect("release-key.pub (the project's release public key) is missing");
    println!(
        "cargo:rustc-env=BMUSTER_RELEASE_KEY={}",
        checked_key("release-key.pub", release_key.trim())
    );

    let extra = std::env::var("BMUSTER_EXTRA_RELEASE_KEY").unwrap_or_default();
    let extra = extra.trim();
    let extra = if extra.is_empty() {
        String::new()
    } else {
        checked_key("BMUSTER_EXTRA_RELEASE_KEY", extra)
    };
    println!("cargo:rustc-env=BMUSTER_EXTRA_RELEASE_KEY={extra}");

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=release-key.pub");
    println!("cargo:rerun-if-env-changed=BMUSTER_VERSION");
    println!("cargo:rerun-if-env-changed=BMUSTER_EXTRA_RELEASE_KEY");
}

/// A raw Ed25519 public key in standard base64 (32 bytes), or the build stops.
fn checked_key(source: &str, text: &str) -> String {
    match bmuster_protocol::decode_public_key(text) {
        Ok(key) => BASE64.encode(key.as_bytes()),
        Err(e) => panic!("{source}: {e}"),
    }
}
