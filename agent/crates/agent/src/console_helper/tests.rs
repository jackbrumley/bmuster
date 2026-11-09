//! The console helper: its unit, a round trip over a real socket pair
//! with the pipe closing at the end, and a helper that lies about sizes.

use super::probe::named;
use super::*;
use std::os::unix::net::UnixStream;

/// A source with one 2×1 display whose pixels the test sets.
struct Screen {
    pixels: Arc<Mutex<Vec<u8>>>,
    last: Option<Vec<u8>>,
}

impl KmsSource for Screen {
    fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>> {
        Ok(vec![KmsDisplay {
            id: "card0-eDP-1".into(),
            name: "eDP-1".into(),
            card: "card0".into(),
            crtc_id: 51,
            x: 0,
            y: 0,
            width: 2,
            height: 1,
            fb_x: 0,
            fb_y: 0,
            primary: true,
        }])
    }
    fn capture(&mut self, id: &str, full: bool) -> CaptureResult<Option<Frame>> {
        if id != "card0-eDP-1" {
            return Err(CaptureError::new("The display is off"));
        }
        let pixels = self.pixels.lock().unwrap().clone();
        if !full && self.last.as_ref() == Some(&pixels) {
            return Ok(None);
        }
        self.last = Some(pixels.clone());
        Ok(Some(Frame {
            width: 2,
            height: 1,
            stride: 8,
            data: pixels,
        }))
    }
    fn cursor(&mut self, _id: &str) -> CaptureResult<KmsCursor> {
        Ok(KmsCursor {
            visible: true,
            x: -3,
            y: 4,
            shape: 9,
        })
    }
    fn cursor_image(&mut self, shape: u32) -> CaptureResult<Option<CursorImage>> {
        Ok((shape == 9).then(|| CursorImage {
            width: 1,
            height: 1,
            hotspot_x: 0,
            hotspot_y: 0,
            rgba: vec![1, 2, 3, 4],
        }))
    }
}

fn property<'a>(args: &'a [OsString], name: &str) -> Vec<&'a str> {
    args.windows(2)
        .filter(|pair| pair[0] == "-p")
        .filter_map(|pair| pair[1].to_str())
        .filter(|p| p.split_once('=').is_some_and(|(key, _)| key == name))
        .map(|p| p.split_once('=').map_or("", |(_, value)| value))
        .collect()
}

#[test]
fn unit_properties() {
    let socket = "/run/bmuster/connect/00112233445566778899aabbccddeeff.sock";
    let args = unit_arguments(
        "bmuster-console-1-1.service",
        Path::new("/opt/bmuster/versions/current/bmuster-agent"),
        Path::new(socket),
        Path::new("/var/lib/bmuster"),
    );
    let text: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
    assert!(!text.contains(&"--pipe"), "no agent pipes through systemd");
    assert!(text.contains(&"--wait") && text.contains(&"--collect"));
    assert_eq!(property(&args, "StandardInput"), vec!["null"]);
    assert!(text.contains(&"--unit=bmuster-console-1-1.service"));
    // Root, but only the capability reading a framebuffer needs.
    assert!(!text.iter().any(|a| a.starts_with("--uid")));
    assert_eq!(
        property(&args, "CapabilityBoundingSet"),
        vec!["CAP_SYS_ADMIN"]
    );
    assert_eq!(property(&args, "NoNewPrivileges"), vec!["yes"]);
    // /dev/dri only.
    assert_eq!(property(&args, "DevicePolicy"), vec!["closed"]);
    assert_eq!(property(&args, "DeviceAllow"), vec!["char-drm rw"]);
    // No network.
    assert_eq!(property(&args, "PrivateNetwork"), vec!["yes"]);
    assert_eq!(property(&args, "IPAddressDeny"), vec!["any"]);
    assert_eq!(property(&args, "RestrictAddressFamilies"), vec!["AF_UNIX"]);
    // No agent data, nothing writable.
    assert_eq!(
        property(&args, "InaccessiblePaths"),
        vec!["-/var/lib/bmuster"]
    );
    assert_eq!(property(&args, "ProtectSystem"), vec!["strict"]);
    assert_eq!(property(&args, "ProtectHome"), vec!["yes"]);
    // GPU drivers need to write and run shader code.
    assert_eq!(property(&args, "MemoryDenyWriteExecute"), vec!["no"]);
    // The current version under /opt (never /var/lib); no secrets
    // on the command line, only the socket's path.
    assert_eq!(
        &text[text.len() - 3..],
        &[
            "/opt/bmuster/versions/current/bmuster-agent",
            "console-helper",
            socket
        ]
    );
    assert!(!text
        .iter()
        .any(|a| a.contains("token") || a.contains("key")));
}

#[test]
fn helper_round_trip_and_cleanup() {
    let (agent_end, helper_end) = UnixStream::pair().unwrap();
    let pixels = Arc::new(Mutex::new(vec![1, 2, 3, 0, 4, 5, 6, 0]));
    let helper = {
        let pixels = pixels.clone();
        let (reading, writing) = (helper_end.try_clone().unwrap(), helper_end);
        std::thread::spawn(move || {
            let mut screen = Screen { pixels, last: None };
            serve(reading, writing, &mut screen)
        })
    };
    let mut client = HelperClient::over(
        Box::new(agent_end.try_clone().unwrap()),
        Box::new(agent_end.try_clone().unwrap()),
        Box::new(()),
    );
    assert_eq!(client.displays().unwrap()[0].id, "card0-eDP-1");
    let frame = client.capture("card0-eDP-1", false).unwrap().unwrap();
    assert_eq!(
        (frame.width, frame.height, frame.row(0)),
        (2, 1, &[1, 2, 3, 0, 4, 5, 6, 0][..])
    );
    assert!(
        client.capture("card0-eDP-1", false).unwrap().is_none(),
        "unchanged"
    );
    *pixels.lock().unwrap() = vec![9; 8];
    assert_eq!(
        client.capture("card0-eDP-1", false).unwrap().unwrap().data,
        vec![9; 8]
    );
    assert!(
        client.capture("card0-eDP-1", true).unwrap().is_some(),
        "full"
    );
    // A helper error is the reason, and the client keeps working.
    assert_eq!(
        client.capture("card0-HDMI-A-1", false).unwrap_err().0,
        "The display is off"
    );
    let cursor = client.cursor("card0-eDP-1").unwrap();
    assert_eq!((cursor.x, cursor.y, cursor.shape), (-3, 4, 9));
    assert_eq!(
        client.cursor_image(9).unwrap().unwrap().rgba,
        vec![1, 2, 3, 4]
    );
    assert!(client.cursor_image(10).unwrap().is_none());
    // Closing the pipe ends the helper.
    drop(client);
    agent_end.shutdown(std::net::Shutdown::Both).unwrap();
    helper.join().unwrap().unwrap();
}

/// CB6: the helper connects back to a real connect socket, passes the peer
/// check, answers over it, and ends when the agent's side closes.
#[test]
fn over_socket() {
    use crate::exec::connect::{ConnectSocket, Folder, Peer, CONNECT_WAIT};
    let dir = tempfile::tempdir().unwrap();
    // SAFETY: geteuid cannot fail.
    let uid = unsafe { libc::geteuid() };
    let socket = ConnectSocket::create(&Folder::at(dir.path()), uid).unwrap();
    let path = socket.path().to_path_buf();
    let pixels = Arc::new(Mutex::new(vec![1, 2, 3, 0, 4, 5, 6, 0]));
    let helper = std::thread::spawn(move || {
        let stream = UnixStream::connect(&path).unwrap();
        let mut screen = Screen { pixels, last: None };
        serve_stream(stream, &mut screen)
    });
    let unit = "bmuster-console-1-1.service";
    let stream = socket
        .accept_checked(
            &Peer::new(uid, unit, Manager::System),
            CONNECT_WAIT,
            &mut || None,
            &|_| Ok(format!("0::/system.slice/{unit}\n")),
        )
        .unwrap();
    let closing = stream.try_clone().unwrap();
    let mut client = HelperClient::over(
        Box::new(stream.try_clone().unwrap()),
        Box::new(stream),
        Box::new(()),
    );
    assert_eq!(client.displays().unwrap()[0].id, "card0-eDP-1");
    let frame = client.capture("card0-eDP-1", true).unwrap().unwrap();
    assert_eq!(frame.row(0), &[1, 2, 3, 0, 4, 5, 6, 0][..]);
    // Closing the socket ends the helper.
    closing.shutdown(std::net::Shutdown::Both).unwrap();
    helper.join().unwrap().unwrap();
    drop(client);
}

#[test]
fn a_lying_helper_is_cut_off() {
    let (agent_end, mut helper_end) = UnixStream::pair().unwrap();
    let mut client = HelperClient::over(
        Box::new(agent_end.try_clone().unwrap()),
        Box::new(agent_end),
        Box::new(()),
    );
    // Announces a 2×2 frame, then sends 3 bytes.
    let liar = std::thread::spawn(move || {
        let _ = wire::read(&mut helper_end).unwrap();
        wire::json(
            &mut helper_end,
            &Reply::Frame {
                width: 2,
                height: 2,
            },
        )
        .unwrap();
        wire::write(&mut helper_end, &Packet::Raw(vec![0; 3])).unwrap();
        helper_end
    });
    assert!(client.capture("x", true).is_err());
    let _helper_end = liar.join().unwrap();
    assert!(client
        .displays()
        .unwrap_err()
        .0
        .contains("wrong number of pixels"));
    assert_eq!(
        named(Path::new("/tmp/screen.png"), "card1-eDP-1"),
        PathBuf::from("/tmp/screen-card1-eDP-1.png")
    );
}
