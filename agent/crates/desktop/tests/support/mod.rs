//! A nested X server for the X11 tests (SPEC-DESKTOP 11.2).
//!
//! The server is headless by default, so `npm run verify` never opens a
//! window on the developer's screen:
//!
//! - `BMUSTER_XVFB=<path>` runs that Xvfb binary;
//! - otherwise `Xvfb` on `PATH`;
//! - `Xephyr` (a window on the current desktop) only when
//!   `BMUSTER_X_TESTS=xephyr` asks for it;
//! - otherwise, or with `BMUSTER_SKIP_X_TESTS` set, the tests pass after one
//!   "skipped: no headless X server" line.
//!
//! The server gets its own cookie in its own Xauthority file, so the tests
//! go through the same Xauthority path as a real greeter. It never runs on
//! the test's own `DISPLAY`, nor on `:0` or `:1`, so no test can capture or
//! inject into the real session. `BMUSTER_TEST_X_DIR` keeps the Xauthority
//! and the server's log in a folder of your choice instead of a temporary one.

use bmuster_desktop::capture::x11_session::{write_xauth_entry, X11Target, XauthEntry};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, MutexGuard, Once};
use std::time::Duration;

/// First display number tried.
const FIRST_DISPLAY: u16 = 90;
static NEXT_DISPLAY: AtomicU16 = AtomicU16::new(FIRST_DISPLAY);
/// One nested server at a time: kinder to the desktop, and keyboard-map
/// changes in one test cannot reach another.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
static SKIP_NOTICE: Once = Once::new();

/// Which X server the tests run.
enum Server {
    Xvfb(PathBuf),
    Xephyr,
}

/// Picks the server from the environment (see the module notes), or `None`
/// to skip. A setting that names a server that cannot run fails loudly.
fn choose_server() -> Option<Server> {
    if std::env::var_os("BMUSTER_SKIP_X_TESTS").is_some() {
        return None;
    }
    if std::env::var("BMUSTER_X_TESTS").as_deref() == Ok("xephyr") {
        assert!(
            in_path("Xephyr") && std::env::var_os("DISPLAY").is_some(),
            "BMUSTER_X_TESTS=xephyr needs Xephyr on PATH and a DISPLAY to open its window on"
        );
        return Some(Server::Xephyr);
    }
    if let Some(path) = std::env::var_os("BMUSTER_XVFB") {
        let path = PathBuf::from(path);
        assert!(
            path.is_file(),
            "BMUSTER_XVFB={} is not a file",
            path.display()
        );
        return Some(Server::Xvfb(path));
    }
    find_in_path("Xvfb").map(Server::Xvfb)
}

/// The server to run, or `None` after saying once why the tests skip.
fn server_or_skip() -> Option<Server> {
    let server = choose_server();
    if server.is_none() {
        SKIP_NOTICE.call_once(|| {
            // Straight to stderr: the test harness hides eprintln! output
            // of passing tests, and this line should be seen once.
            use std::io::Write as _;
            let _ = writeln!(
                std::io::stderr().lock(),
                "X11 tests skipped: no headless X server (install Xvfb, set BMUSTER_XVFB, \
                 or set BMUSTER_X_TESTS=xephyr)"
            );
        });
    }
    server
}

pub struct NestedX {
    pub target: X11Target,
    pub number: u16,
    child: Child,
    _dir: Option<tempfile::TempDir>,
    /// Shared by both servers of a pair: the turn ends with the last one.
    _turn: Rc<MutexGuard<'static, ()>>,
}

fn find_in_path(program: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}

fn in_path(program: &str) -> bool {
    find_in_path(program).is_some()
}

fn display_number(display: &str) -> Option<u16> {
    let after = display.rsplit_once(':')?.1;
    after.split('.').next()?.parse().ok()
}

/// Refuses any display that could be the real session.
pub fn assert_not_real_display(number: u16) {
    let real = std::env::var("DISPLAY")
        .ok()
        .and_then(|d| display_number(&d));
    assert!(
        Some(number) != real && number > 1,
        "refusing to test on display :{number}: it may be the real session (DISPLAY={real:?})"
    );
}

fn random_cookie() -> Vec<u8> {
    let mut cookie = vec![0u8; 16];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut cookie))
        .expect("reading /dev/urandom");
    cookie
}

fn hostname() -> Vec<u8> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|h| h.trim().as_bytes().to_vec())
        .unwrap_or_default()
}

impl NestedX {
    /// Starts a nested server, or returns `None` (and says why) to skip.
    pub fn start() -> Option<NestedX> {
        let server = server_or_skip()?;
        let turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
        Some(NestedX::launch(&server, Rc::new(turn)))
    }

    /// Two nested servers at once, each with its own cookie (the screen
    /// switch tests), or `None` to skip.
    pub fn start_two() -> Option<(NestedX, NestedX)> {
        let server = server_or_skip()?;
        let turn = Rc::new(ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner()));
        let first = NestedX::launch(&server, Rc::clone(&turn));
        let second = NestedX::launch(&server, turn);
        Some((first, second))
    }

    fn launch(server: &Server, turn: Rc<MutexGuard<'static, ()>>) -> NestedX {
        let name = match server {
            Server::Xvfb(_) => "Xvfb",
            Server::Xephyr => "Xephyr",
        };
        let (dir, base) = match std::env::var_os("BMUSTER_TEST_X_DIR") {
            Some(base) => {
                let base = PathBuf::from(base);
                std::fs::create_dir_all(&base).expect("creating BMUSTER_TEST_X_DIR");
                (None, base)
            }
            None => {
                let dir = tempfile::tempdir().expect("temporary folder");
                let base = dir.path().to_path_buf();
                (Some(dir), base)
            }
        };

        for _ in 0..40 {
            let number = NEXT_DISPLAY.fetch_add(1, Ordering::SeqCst);
            assert_not_real_display(number);
            if Path::new(&format!("/tmp/.X{number}-lock")).exists()
                || Path::new(&format!("/tmp/.X11-unix/X{number}")).exists()
            {
                continue;
            }
            let xauthority = base.join(format!("xauthority-{number}"));
            let mut file = Vec::new();
            write_xauth_entry(
                &mut file,
                &XauthEntry {
                    family: 256,
                    address: hostname(),
                    number: number.to_string().into_bytes(),
                    name: b"MIT-MAGIC-COOKIE-1".to_vec(),
                    data: random_cookie(),
                },
            );
            {
                use std::io::Write as _;
                use std::os::unix::fs::OpenOptionsExt as _;
                std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .truncate(true)
                    .mode(0o600)
                    .open(&xauthority)
                    .and_then(|mut f| f.write_all(&file))
                    .expect("writing the Xauthority");
            }
            let log = std::fs::File::create(base.join(format!("{name}-{number}.log")))
                .expect("server log");

            let display = format!(":{number}");
            let mut command = match server {
                Server::Xvfb(path) => {
                    let mut command = Command::new(path);
                    command.arg(&display).args(["-screen", "0", "1280x800x24"]);
                    command
                }
                Server::Xephyr => {
                    let mut command = Command::new("Xephyr");
                    command.arg(&display).args([
                        "-screen",
                        "1280x800x24",
                        "-title",
                        "BMuster desktop test",
                    ]);
                    command
                }
            };
            command
                // -noreset: without it the server resets (and forgets a
                // layout set by setxkbmap) whenever its last client leaves.
                .args(["-nolisten", "tcp", "-br", "-noreset", "-auth"])
                .arg(&xauthority)
                .args(["-displayfd", "1"])
                .env_remove("BMUSTER_DESKTOP_DISPLAY")
                .env_remove("BMUSTER_DESKTOP_XAUTHORITY")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(log);
            let mut child = command.spawn().expect("starting the nested X server");

            // The server writes its display number to stdout once it is ready.
            let stdout = child.stdout.take().expect("server stdout");
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut line = String::new();
                let _ = BufReader::new(stdout).read_line(&mut line);
                let _ = tx.send(line);
            });
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok(line) if line.trim() == number.to_string() => {
                    return NestedX {
                        target: X11Target {
                            display,
                            xauthority: Some(xauthority),
                        },
                        number,
                        child,
                        _dir: dir,
                        _turn: turn,
                    };
                }
                _ => stop(&mut child),
            }
        }
        panic!("could not start {name} on any display from :{FIRST_DISPLAY}");
    }

    /// Runs an X client (setxkbmap, xclip) against the nested server only.
    pub fn run_client(&self, program: &str, args: &[&str]) -> std::process::Output {
        assert_not_real_display(self.number);
        Command::new(program)
            .args(args)
            .env("DISPLAY", &self.target.display)
            .env(
                "XAUTHORITY",
                self.target.xauthority.as_ref().expect("test Xauthority"),
            )
            .output()
            .unwrap_or_else(|e| panic!("running {program}: {e}"))
    }
}

/// Asks the server to stop (SIGTERM, so it removes its socket and lock
/// file), and kills it if it has not gone within two seconds.
fn stop(child: &mut Child) {
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: signals our own child process, which has not been reaped.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    for _ in 0..40 {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for NestedX {
    fn drop(&mut self) {
        stop(&mut self.child);
    }
}
