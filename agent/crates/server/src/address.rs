//! The address to open in a browser after installing.

use crate::config::Listen;
use std::net::{IpAddr, UdpSocket};

/// This machine's address on its main network: the source address the
/// system would use to reach the outside. A UDP "connect" sends nothing.
pub fn lan_address() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    // TEST-NET-1 (RFC 5737): never answered, only routed.
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

pub fn url(host: IpAddr, listen: Listen) -> String {
    let scheme = if listen.https { "https" } else { "http" };
    let host = match host {
        IpAddr::V4(ip) => ip.to_string(),
        IpAddr::V6(ip) => format!("[{ip}]"),
    };
    format!("{scheme}://{host}:{}", listen.port)
}

/// The address on this machine's network, or on this machine alone.
pub fn best_url(listen: Listen) -> String {
    url(
        lan_address().unwrap_or(IpAddr::from([127, 0, 0, 1])),
        listen,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_carry_the_scheme_and_port() {
        let https = Listen {
            port: 8443,
            https: true,
        };
        assert_eq!(
            url(IpAddr::from([192, 168, 1, 20]), https),
            "https://192.168.1.20:8443"
        );
        assert_eq!(
            url(
                "fd00::5".parse().unwrap(),
                Listen {
                    https: false,
                    ..https
                }
            ),
            "http://[fd00::5]:8443"
        );
    }
}
