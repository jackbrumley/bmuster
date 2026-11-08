fn main() {
    println!(
        "cargo:rustc-env=BMUSTER_TARGET={}",
        std::env::var("TARGET").expect("Cargo target")
    );
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../agent/release-key.pub");
}
