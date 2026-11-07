//! Connecting to the X display at the machine (SPEC-DESKTOP 6.1).
//!
//! `x11_follow` asks logind (through [`loginctl`]) which session seat0
//! shows. The Xauthority comes from the session's own processes
//! (`XAUTHORITY` in their environment), else from the X server's `-auth`
//! argument (the greeter's), else GDM's per-user file, else the user's
//! `~/.Xauthority` ([`find_xauthority`]). The cookie is read here and handed
//! to x11rb directly, so the agent never changes its own environment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use x11rb::reexports::x11rb_protocol::xauth::Family;
use x11rb::rust_connection::{DefaultStream, RustConnection};

const COOKIE_NAME: &[u8] = b"MIT-MAGIC-COOKIE-1";

/// Where to connect: a display name and the Xauthority file for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X11Target {
    pub display: String,
    pub xauthority: Option<PathBuf>,
}

/// The Xauthority for an X session at seat0: from the session's own
/// processes, else the X server's `-auth` argument (LightDM, SDDM, GDM
/// greeters), else GDM's per-user file, else the user's `~/.Xauthority`.
/// `None` connects without a cookie.
pub fn find_xauthority(session: &str, display: &str, user: &str, uid: &str) -> Option<PathBuf> {
    let found = session_xauthority(session, display)
        .or_else(|| xorg_xauthority_from_proc(display))
        .or_else(|| gdm_xauthority(uid))
        .or_else(|| home_xauthority(user));
    if found.is_none() {
        log::warn!("No Xauthority found for {display}; connecting without a cookie");
    }
    found
}

/// GDM on X11 keeps the cookie in `/run/user/<uid>/gdm/Xauthority`, for
/// its greeter user and for each signed-in user.
fn gdm_xauthority(uid: &str) -> Option<PathBuf> {
    if uid.is_empty() || !uid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let path = PathBuf::from(format!("/run/user/{uid}/gdm/Xauthority"));
    path.exists().then_some(path)
}

pub(crate) fn loginctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("loginctl")
        .args(args)
        .output()
        .map_err(|e| format!("could not run loginctl: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "loginctl {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// `Key=Value` lines from `loginctl show-*`.
pub fn parse_properties(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

/// The display number in `:0`, `:0.0` or `host:1`.
fn display_number(display: &str) -> Option<&str> {
    let after = display.rsplit_once(':')?.1;
    Some(after.split('.').next().unwrap_or(after))
}

fn proc_processes() -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .bytes()
                .all(|b| b.is_ascii_digit())
        })
        .map(|entry| entry.path())
}

fn session_xauthority(session: &str, display: &str) -> Option<PathBuf> {
    proc_processes().find_map(|process| {
        let environ = std::fs::read(process.join("environ")).ok()?;
        xauthority_from_environ(&environ, session, display)
    })
}

/// `XAUTHORITY` from one process environment (NUL-separated), when the
/// process belongs to `session` and uses `display`.
pub fn xauthority_from_environ(environ: &[u8], session: &str, display: &str) -> Option<PathBuf> {
    let mut vars = HashMap::new();
    for entry in environ.split(|&b| b == 0) {
        let entry = String::from_utf8_lossy(entry);
        if let Some((key, value)) = entry.split_once('=') {
            vars.insert(key.to_string(), value.to_string());
        }
    }
    let same_display = vars
        .get("DISPLAY")
        .is_some_and(|d| display_number(d) == display_number(display));
    if vars.get("XDG_SESSION_ID").map(String::as_str) == Some(session) && same_display {
        vars.get("XAUTHORITY")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
    } else {
        None
    }
}

fn xorg_xauthority_from_proc(display: &str) -> Option<PathBuf> {
    let command_lines: Vec<Vec<String>> = proc_processes()
        .filter_map(|process| {
            let raw = std::fs::read(process.join("cmdline")).ok()?;
            Some(
                raw.split(|&b| b == 0)
                    .filter(|part| !part.is_empty())
                    .map(|part| String::from_utf8_lossy(part).into_owned())
                    .collect(),
            )
        })
        .collect();
    xorg_xauthority(&command_lines, display)
}

/// The `-auth` file of the X server for `display`. GDM starts Xorg with
/// `-displayfd` and no display argument; then the only Xorg with `-auth`
/// is taken.
pub fn xorg_xauthority(command_lines: &[Vec<String>], display: &str) -> Option<PathBuf> {
    let servers: Vec<&Vec<String>> = command_lines
        .iter()
        .filter(|argv| {
            argv.first().is_some_and(|program| {
                let name = Path::new(program)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                matches!(name.as_str(), "Xorg" | "X" | "Xorg.bin")
            })
        })
        .collect();
    let auth = |argv: &Vec<String>| {
        argv.windows(2)
            .find(|pair| pair[0] == "-auth")
            .map(|pair| PathBuf::from(&pair[1]))
    };
    let wanted = display_number(display);
    let exact = servers.iter().find_map(|argv| {
        argv.iter()
            .skip(1)
            .any(|arg| arg.starts_with(':') && display_number(arg) == wanted)
            .then(|| auth(argv))
            .flatten()
    });
    exact.or_else(|| {
        let unnamed: Vec<PathBuf> = servers
            .iter()
            .filter(|argv| !argv.iter().skip(1).any(|arg| arg.starts_with(':')))
            .filter_map(|argv| auth(argv))
            .collect();
        (unnamed.len() == 1).then(|| unnamed[0].clone())
    })
}

fn home_xauthority(user: &str) -> Option<PathBuf> {
    if user.is_empty() {
        return None;
    }
    let passwd = std::fs::read_to_string("/etc/passwd").ok()?;
    let home = passwd.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        (fields.len() > 5 && fields[0] == user).then(|| fields[5].to_string())
    })?;
    let path = Path::new(&home).join(".Xauthority");
    path.exists().then_some(path)
}

/// One entry of an Xauthority file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XauthEntry {
    pub family: u16,
    pub address: Vec<u8>,
    pub number: Vec<u8>,
    pub name: Vec<u8>,
    pub data: Vec<u8>,
}

/// Reads an Xauthority file: each entry is a big-endian u16 family, then
/// four length-prefixed byte strings. A truncated tail is ignored.
pub fn parse_xauthority(mut bytes: &[u8]) -> Vec<XauthEntry> {
    fn take_u16(bytes: &mut &[u8]) -> Option<u16> {
        let (head, rest) = bytes.split_first_chunk::<2>()?;
        *bytes = rest;
        Some(u16::from_be_bytes(*head))
    }
    fn take_field(bytes: &mut &[u8]) -> Option<Vec<u8>> {
        let len = take_u16(bytes)? as usize;
        if bytes.len() < len {
            return None;
        }
        let (field, rest) = bytes.split_at(len);
        *bytes = rest;
        Some(field.to_vec())
    }
    let mut entries = Vec::new();
    loop {
        let entry = (|| {
            Some(XauthEntry {
                family: take_u16(&mut bytes)?,
                address: take_field(&mut bytes)?,
                number: take_field(&mut bytes)?,
                name: take_field(&mut bytes)?,
                data: take_field(&mut bytes)?,
            })
        })();
        match entry {
            Some(entry) => entries.push(entry),
            None => return entries,
        }
    }
}

/// Writes one Xauthority entry (tests write their nested server's cookie).
pub fn write_xauth_entry(out: &mut Vec<u8>, entry: &XauthEntry) {
    out.extend_from_slice(&entry.family.to_be_bytes());
    for field in [&entry.address, &entry.number, &entry.name, &entry.data] {
        out.extend_from_slice(&(field.len() as u16).to_be_bytes());
        out.extend_from_slice(field);
    }
}

/// The MIT cookie for a connection, matched as Xlib does (family and
/// address, or a wildcard; the display number, or none). When the host name
/// changed since the file was written, a local entry for the same display
/// number is used.
pub fn pick_cookie(
    entries: &[XauthEntry],
    family: Family,
    address: &[u8],
    display: u16,
) -> Option<Vec<u8>> {
    let number = display.to_string().into_bytes();
    let cookies = || {
        entries
            .iter()
            .filter(|e| e.name == COOKIE_NAME)
            .filter(|e| e.number.is_empty() || e.number == number)
    };
    let exact = cookies().find(|e| {
        let entry_family = Family::from(e.family);
        entry_family == Family::WILD || (entry_family == family && e.address == address)
    });
    exact
        .or_else(|| {
            (family == Family::LOCAL)
                .then(|| cookies().find(|e| Family::from(e.family) == Family::LOCAL))
                .flatten()
        })
        .map(|e| e.data.clone())
}

/// Connects to the target's display with its Xauthority cookie. Returns the
/// connection and the screen number.
pub fn connect(target: &X11Target) -> Result<(RustConnection, usize), String> {
    let parsed =
        x11rb::reexports::x11rb_protocol::parse_display::parse_display(Some(&target.display))
            .map_err(|e| format!("bad display name {:?}: {e}", target.display))?;
    let entries = match &target.xauthority {
        Some(path) => parse_xauthority(
            &std::fs::read(path)
                .map_err(|e| format!("cannot read Xauthority {}: {e}", path.display()))?,
        ),
        None => Vec::new(),
    };
    let screen = usize::from(parsed.screen);
    let mut last_error = String::from("no address to connect to");
    for address in parsed.connect_instruction() {
        match DefaultStream::connect(&address) {
            Ok((stream, (family, peer))) => {
                let cookie = pick_cookie(&entries, family, &peer, parsed.display);
                let (name, data) = match cookie {
                    Some(data) => (COOKIE_NAME.to_vec(), data),
                    None => (Vec::new(), Vec::new()),
                };
                return RustConnection::connect_to_stream_with_auth_info(
                    stream, screen, name, data,
                )
                .map(|connection| (connection, screen))
                .map_err(|e| format!("cannot connect to X display {}: {e}", target.display));
            }
            Err(e) => last_error = e.to_string(),
        }
    }
    Err(format!(
        "cannot reach X display {}: {last_error}",
        target.display
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(family: u16, address: &str, number: &str, data: &[u8]) -> XauthEntry {
        XauthEntry {
            family,
            address: address.as_bytes().to_vec(),
            number: number.as_bytes().to_vec(),
            name: COOKIE_NAME.to_vec(),
            data: data.to_vec(),
        }
    }

    #[test]
    fn xauthority_round_trips_and_ignores_a_truncated_tail() {
        let entries = vec![entry(256, "box", "0", &[1, 2]), entry(65535, "", "", &[3])];
        let mut bytes = Vec::new();
        for e in &entries {
            write_xauth_entry(&mut bytes, e);
        }
        bytes.extend_from_slice(&[1, 0, 0]);
        assert_eq!(parse_xauthority(&bytes), entries);
    }

    #[test]
    fn xauthority_cookie_matching() {
        let entries = vec![
            entry(256, "box", "1", &[1]),
            entry(256, "box", "0", &[2]),
            entry(65535, "", "7", &[3]),
        ];
        assert_eq!(
            pick_cookie(&entries, Family::LOCAL, b"box", 0),
            Some(vec![2])
        );
        assert_eq!(
            pick_cookie(&entries, Family::LOCAL, b"box", 7),
            Some(vec![3])
        );
        // Host renamed since the file was written: local entry for :1.
        assert_eq!(
            pick_cookie(&entries, Family::LOCAL, b"renamed", 1),
            Some(vec![1])
        );
        assert_eq!(
            pick_cookie(&entries, Family::INTERNET, b"\x7f\0\0\x01", 1),
            None
        );
    }

    #[test]
    fn seat_xauthority_from_session_environment() {
        let environ = b"HOME=/home/jack\0XDG_SESSION_ID=4\0DISPLAY=:1.0\0XAUTHORITY=/run/user/1000/gdm/Xauthority\0";
        assert_eq!(
            xauthority_from_environ(environ, "4", ":1"),
            Some(PathBuf::from("/run/user/1000/gdm/Xauthority"))
        );
        assert_eq!(xauthority_from_environ(environ, "5", ":1"), None);
        assert_eq!(xauthority_from_environ(environ, "4", ":0"), None);
    }

    #[test]
    fn seat_xauthority_from_the_x_server_command_line() {
        let argv = |s: &str| s.split(' ').map(str::to_string).collect::<Vec<_>>();
        let lines = vec![
            argv("/usr/lib/xorg/Xorg :0 -seat seat0 -auth /var/run/lightdm/root/:0 -nolisten tcp vt7"),
            argv("/usr/bin/Xephyr :97 -auth /tmp/other"),
            argv("bash -auth nope"),
        ];
        assert_eq!(
            xorg_xauthority(&lines, ":0"),
            Some(PathBuf::from("/var/run/lightdm/root/:0"))
        );
        assert_eq!(xorg_xauthority(&lines, ":97"), None);
        let gdm = vec![argv(
            "/usr/lib/xorg/Xorg vt2 -displayfd 3 -auth /run/user/1000/gdm/Xauthority -nolisten tcp",
        )];
        assert_eq!(
            xorg_xauthority(&gdm, ":1"),
            Some(PathBuf::from("/run/user/1000/gdm/Xauthority"))
        );
    }
}
