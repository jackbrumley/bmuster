//! The local page's own files: its self-signed certificate (ECDSA P-256,
//! which every browser accepts) and its sign-in secret. Both are made on
//! first run and kept in the data folder; the private parts are owner-only.

use crate::identity::{check_private, write_private};
use crate::inventory;
use crate::paths::{LOCAL_PAGE_CERT_FILE, LOCAL_PAGE_KEY_FILE, LOCAL_PAGE_SECRET_FILE};
use crate::totp::SECRET_BYTES;
use anyhow::{Context as _, Result};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType, SerialNumber, PKCS_ECDSA_P256_SHA256,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct PageCertificate {
    pub cert_der: Vec<u8>,
    /// PKCS #8.
    pub key_der: Vec<u8>,
    /// SHA-256 of `cert_der`, lower-case hex.
    pub sha256_hex: String,
}

/// The certificate's SHA-256 as browsers show it: `AB:CD:…`.
pub fn fingerprint(sha256_hex: &str) -> String {
    sha256_hex
        .as_bytes()
        .chunks(2)
        .map(|pair| String::from_utf8_lossy(pair).to_ascii_uppercase())
        .collect::<Vec<_>>()
        .join(":")
}

pub fn load_or_create_secret(dir: &Path) -> Result<Vec<u8>> {
    let path = dir.join(LOCAL_PAGE_SECRET_FILE);
    if path.exists() {
        check_private(&path)?;
        let secret =
            fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
        if secret.len() != SECRET_BYTES {
            anyhow::bail!(
                "{} is damaged (not {SECRET_BYTES} bytes); delete it to make a new one",
                path.display()
            );
        }
        return Ok(secret);
    }
    let mut secret = vec![0u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret).context("could not get random bytes for the secret")?;
    write_private(&path, &secret)?;
    log::info!("Made the local page's sign-in secret.");
    Ok(secret)
}

pub fn load_or_create_certificate(dir: &Path) -> Result<PageCertificate> {
    let cert_path = dir.join(LOCAL_PAGE_CERT_FILE);
    let key_path = dir.join(LOCAL_PAGE_KEY_FILE);
    let (cert_der, key_der) = if cert_path.exists() && key_path.exists() {
        check_private(&key_path)?;
        (
            fs::read(&cert_path)
                .with_context(|| format!("could not read {}", cert_path.display()))?,
            fs::read(&key_path)
                .with_context(|| format!("could not read {}", key_path.display()))?,
        )
    } else {
        let (cert, key) = make_certificate()?;
        write_private(&key_path, &key)?;
        write_private(&cert_path, &cert)?;
        log::info!("Made the local page's certificate.");
        (cert, key)
    };
    let sha256_hex = hex::encode(Sha256::digest(&cert_der));
    Ok(PageCertificate {
        cert_der,
        key_der,
        sha256_hex,
    })
}

/// A self-signed leaf for `localhost`, 127.0.0.1, ::1 and this machine's name.
fn make_certificate() -> Result<(Vec<u8>, Vec<u8>)> {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)
        .context("could not make the local page's key")?;
    let mut params = CertificateParams::new(vec!["localhost".to_string()])
        .context("could not set up the local page's certificate")?;
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    if let Ok(host) = inventory::hostname() {
        // A hostname that is not a valid DNS name is simply left out.
        if let Ok(name) = host.to_ascii_lowercase().try_into() {
            params.subject_alt_names.push(SanType::DnsName(name));
        }
    }
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, "BMuster agent local page");
    params.distinguished_name = name;
    params.is_ca = IsCa::ExplicitNoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    // A random serial: browsers refuse two certificates with the same issuer
    // and serial, which a remade certificate would otherwise risk.
    let mut serial = [0u8; 16];
    getrandom::getrandom(&mut serial).context("could not get random bytes for the serial")?;
    serial[0] &= 0x7f;
    params.serial_number = Some(SerialNumber::from_slice(&serial));
    let year = current_year();
    params.not_before = rcgen::date_time_ymd(year - 1, 1, 1);
    params.not_after = rcgen::date_time_ymd(year + 20, 1, 1);
    let certificate = params
        .self_signed(&key)
        .context("could not sign the local page's certificate")?;
    Ok((certificate.der().to_vec(), key.serialize_der()))
}

/// The calendar year near enough for certificate dates (a day either side
/// of New Year does not matter with a year of slack).
fn current_year() -> i32 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let years = seconds / 31_556_952;
    1970 + i32::try_from(years).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::CertificateDer;

    #[test]
    fn makes_a_certificate_once_and_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_certificate(dir.path()).unwrap();
        let again = load_or_create_certificate(dir.path()).unwrap();
        assert_eq!(first.cert_der, again.cert_der);
        assert_eq!(first.sha256_hex.len(), 64);
        let der = CertificateDer::from(first.cert_der.clone());
        let parsed = webpki::EndEntityCert::try_from(&der).expect("a certificate webpki can read");
        let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
        parsed
            .verify_is_valid_for_subject_name(&name)
            .expect("valid for localhost");
        let ip = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
        parsed
            .verify_is_valid_for_subject_name(&ip)
            .expect("valid for 127.0.0.1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(dir.path().join(LOCAL_PAGE_KEY_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn makes_a_secret_once() {
        let dir = tempfile::tempdir().unwrap();
        let first = load_or_create_secret(dir.path()).unwrap();
        assert_eq!(first.len(), SECRET_BYTES);
        assert_eq!(load_or_create_secret(dir.path()).unwrap(), first);
    }

    #[test]
    fn fingerprints_read_like_a_browser() {
        assert_eq!(fingerprint("ab01ff"), "AB:01:FF");
    }
}
