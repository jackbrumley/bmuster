//! Records the target triple so enrolment can tell the server which build this is.

fn main() {
    let target = std::env::var("TARGET").expect("cargo sets TARGET for build scripts");
    println!("cargo:rustc-env=BMUSTER_TARGET={target}");
    println!("cargo:rerun-if-changed=build.rs");
}
