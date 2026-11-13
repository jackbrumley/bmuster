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
//! * Windows: the program's icon and version details (SPEC-BRAND-ICON), a
//!   resource file made from `assets/bmuster.ico` and the version without a
//!   resource compiler (`src/tray/resource.rs`), linked into the MSVC build.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

#[path = "src/tray/ico.rs"]
mod ico;
#[path = "src/tray/resource.rs"]
mod resource;

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
    windows_resources(&version);

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

/// Windows builds: writes the icon and version resources and, for the MSVC
/// linker (the release build), links them into the program. MinGW's linker takes resources
/// only as objects from `windres`, so a GNU build has no program icon (its
/// tray still draws the mark from the embedded icon file).
fn windows_resources(version: &str) {
    println!("cargo:rerun-if-changed=assets/bmuster.ico");
    println!("cargo:rerun-if-changed=src/tray/ico.rs");
    println!("cargo:rerun-if-changed=src/tray/resource.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let bytes = std::fs::read("assets/bmuster.ico")
        .expect("assets/bmuster.ico is missing: run npm run icons:generate");
    let images = ico::images(&bytes).unwrap_or_else(|e| panic!("assets/bmuster.ico: {e}"));
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR for build scripts");
    let res = std::path::Path::new(&out_dir).join("bmuster-icon.res");
    let mut compiled = resource::icon_resource(&images);
    resource::version_resource(&mut compiled, version);
    std::fs::write(&res, compiled).unwrap_or_else(|e| panic!("{}: {e}", res.display()));
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins={}", res.display());
    }
}

/// A raw Ed25519 public key in standard base64 (32 bytes), or the build stops.
fn checked_key(source: &str, text: &str) -> String {
    match bmuster_protocol::decode_public_key(text) {
        Ok(key) => BASE64.encode(key.as_bytes()),
        Err(e) => panic!("{source}: {e}"),
    }
}
