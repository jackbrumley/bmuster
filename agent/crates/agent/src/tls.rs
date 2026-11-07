//! TLS for both HTTPS (ureq) and the live socket (tungstenite): one rustls
//! configuration per way of checking the server (SPEC-INSTALL-OPTIONS L5).
//!
//! * [`ServerTrust::Public`]: the operating system's trust store (the
//!   platform verifier), with the usual host name and expiry checks.
//! * [`ServerTrust::Pin`]: exactly one certificate key. The leaf certificate's
//!   SubjectPublicKeyInfo must hash to the pin; the host name, the issuer
//!   chain and the dates are not checked, because a self-signed local network
//!   certificate has no chain and the pin already names the one key that may
//!   answer. The handshake signature is still verified, so only the holder of
//!   that private key gets through.
//! * `--insecure-dev-tls`: any certificate (development only).

use anyhow::{Context as _, Result};
use bmuster_protocol::{CertificatePin, ServerTrust};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme,
    StreamOwned,
};
use rustls_platform_verifier::BuilderVerifierExt as _;
use std::io::{Read as _, Write as _};
use std::sync::Arc;
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, Either, LazyBuffers, NextTimeout, Transport,
    TransportAdapter,
};

/// How one connection checks the server's certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Check {
    Trust(ServerTrust),
    /// `--insecure-dev-tls`: any certificate is accepted.
    AnyCertificate,
}

pub fn crypto_provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// The rustls client configuration for one way of checking.
pub fn client_config(check: Check, provider: Arc<CryptoProvider>) -> Result<Arc<ClientConfig>> {
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .context("could not set up TLS")?;
    let config = match check {
        Check::Trust(ServerTrust::Public) => builder
            .with_platform_verifier()
            .context("could not load the system's trusted certificates")?
            .with_no_client_auth(),
        Check::Trust(ServerTrust::Pin { pin }) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedKey { pin, provider }))
            .with_no_client_auth(),
        Check::AnyCertificate => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate(provider)))
            .with_no_client_auth(),
    };
    Ok(Arc::new(config))
}

/// The pin of a DER certificate's public key, or why it cannot be read.
pub fn certificate_pin(certificate: &CertificateDer<'_>) -> Result<CertificatePin, rustls::Error> {
    let parsed = webpki::EndEntityCert::try_from(certificate)
        .map_err(|_| rustls::Error::InvalidCertificate(CertificateError::BadEncoding))?;
    Ok(CertificatePin::of_public_key_info(
        parsed.subject_public_key_info().as_ref(),
    ))
}

/// Accepts exactly the leaf certificate whose public key matches the pin.
#[derive(Debug)]
struct PinnedKey {
    pin: CertificatePin,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedKey {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let presented = certificate_pin(end_entity)?;
        if presented == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            log::warn!(
                "The server's certificate key ({presented}) is not the pinned one ({}).",
                self.pin
            );
            Err(rustls::Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Accepts any server certificate but still checks the handshake signatures.
/// Only reachable through `--insecure-dev-tls`.
#[derive(Debug)]
struct AcceptAnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

// ---------------------------------------------------------------------------
// ureq connector
// ---------------------------------------------------------------------------

/// Wraps ureq's connections in TLS with our own rustls configuration, so
/// HTTPS checks the server exactly as the live socket does. ureq's own TLS
/// settings cannot take a custom certificate verifier. Modelled on ureq's
/// `RustlsConnector`.
#[derive(Debug)]
pub struct RustlsConnector(pub Arc<ClientConfig>);

impl<In: Transport> Connector<In> for RustlsConnector {
    type Out = Either<In, RustlsTransport>;

    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<In>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        let Some(transport) = chained else {
            return Ok(None);
        };
        if !details.needs_tls() || transport.is_tls() {
            return Ok(Some(Either::A(transport)));
        }
        let host = details
            .uri
            .authority()
            .map(|authority| {
                authority
                    .host()
                    .trim_start_matches('[')
                    .trim_end_matches(']')
            })
            .ok_or(ureq::Error::Tls("the URL has no host"))?;
        let name = ServerName::try_from(host.to_string())
            .map_err(|_| ureq::Error::Tls("the server name is not valid for TLS"))?;
        let mut connection = ClientConnection::new(self.0.clone(), name)?;
        let mut socket = TransportAdapter::new(transport.boxed(), details.current_time.clone());
        socket.set_timeout(details.timeout);
        connection.complete_io(&mut socket)?;
        let buffers = LazyBuffers::new(
            details.config.input_buffer_size(),
            details.config.output_buffer_size(),
        );
        Ok(Some(Either::B(RustlsTransport {
            buffers,
            stream: StreamOwned::new(connection, socket),
        })))
    }
}

pub struct RustlsTransport {
    buffers: LazyBuffers,
    stream: StreamOwned<ClientConnection, TransportAdapter>,
}

impl std::fmt::Debug for RustlsTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RustlsTransport").finish_non_exhaustive()
    }
}

impl Transport for RustlsTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let output = &self.buffers.output()[..amount];
        self.stream.write_all(output)?;
        Ok(())
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let input = self.buffers.input_append_buf();
        let amount = self.stream.read(input)?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        self.stream.get_mut().get_mut().is_open()
    }

    fn is_tls(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::PrivateKeyDer;
    use rustls::sign::{CertifiedKey, SingleCertAndKey};
    use rustls::{ServerConfig, ServerConnection};

    // Two self-signed P-256 certificates and keys, made for these tests only:
    // `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes`,
    // converted to DER (keys as PKCS #8).
    const SERVER_CERT: &[u8] = include_bytes!("../testdata/server-cert.der");
    const SERVER_KEY: &[u8] = include_bytes!("../testdata/server-key.pk8.der");
    const OTHER_CERT: &[u8] = include_bytes!("../testdata/other-cert.der");
    const OTHER_KEY: &[u8] = include_bytes!("../testdata/other-key.pk8.der");
    /// `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`
    const SERVER_PIN: &str = include_str!("../testdata/server-pin.txt");

    fn server_pin() -> CertificatePin {
        CertificatePin::parse(SERVER_PIN).unwrap()
    }

    /// Runs a full TLS handshake in memory between a client checking `check`
    /// and a server presenting `cert` and `key`.
    fn handshake(check: Check, cert: &[u8], key: &[u8]) -> Result<(), rustls::Error> {
        let provider = crypto_provider();
        // Built by hand, so a test can pair a certificate with the wrong key.
        let signing_key = provider
            .key_provider
            .load_private_key(PrivateKeyDer::try_from(key.to_vec()).unwrap())
            .unwrap();
        let certified = CertifiedKey::new(vec![CertificateDer::from(cert.to_vec())], signing_key);
        let server_config = ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(SingleCertAndKey::from(certified)));
        let mut server = ServerConnection::new(Arc::new(server_config)).unwrap();
        let client_config = client_config(check, provider).unwrap();
        // Any name: the pin ignores it, and a mismatch must not matter.
        let name = ServerName::try_from("bmuster.invalid").unwrap();
        let mut client = ClientConnection::new(client_config, name).unwrap();
        for _ in 0..10 {
            let mut to_server = Vec::new();
            client.write_tls(&mut to_server).unwrap();
            server.read_tls(&mut to_server.as_slice()).unwrap();
            server.process_new_packets()?;
            let mut to_client = Vec::new();
            server.write_tls(&mut to_client).unwrap();
            client.read_tls(&mut to_client.as_slice()).unwrap();
            client.process_new_packets()?;
            if !client.is_handshaking() && !server.is_handshaking() {
                return Ok(());
            }
        }
        panic!("the handshake did not finish");
    }

    #[test]
    fn pin_of_a_certificate_matches_openssl() {
        let pin = certificate_pin(&CertificateDer::from(SERVER_CERT)).unwrap();
        assert_eq!(pin, server_pin());
        let other = certificate_pin(&CertificateDer::from(OTHER_CERT)).unwrap();
        assert_ne!(other, pin);
        assert!(certificate_pin(&CertificateDer::from(&b"not a certificate"[..])).is_err());
    }

    #[test]
    fn pinning_accepts_exactly_the_pinned_key() {
        let pinned = Check::Trust(ServerTrust::Pin { pin: server_pin() });
        handshake(pinned, SERVER_CERT, SERVER_KEY).expect("the pinned certificate is accepted");
        let refused = handshake(pinned, OTHER_CERT, OTHER_KEY).unwrap_err();
        assert_eq!(
            refused,
            rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure)
        );
    }

    #[test]
    fn pinning_refuses_the_right_certificate_with_the_wrong_key() {
        // A copy of the pinned certificate is useless without its private key:
        // the handshake signature gives it away.
        let pinned = Check::Trust(ServerTrust::Pin { pin: server_pin() });
        assert!(handshake(pinned, SERVER_CERT, OTHER_KEY).is_err());
    }

    #[test]
    fn the_trust_store_refuses_a_self_signed_certificate() {
        assert!(handshake(Check::Trust(ServerTrust::Public), SERVER_CERT, SERVER_KEY).is_err());
    }

    #[test]
    fn insecure_dev_tls_accepts_anything() {
        handshake(Check::AnyCertificate, OTHER_CERT, OTHER_KEY).unwrap();
    }
}
