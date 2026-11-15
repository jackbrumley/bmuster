//! The tray's desktop notification when a viewer connects (SPEC-DESKTOP
//! 8.2, notice version 2): `org.freedesktop.Notifications` on the person's
//! own session bus, with a Disconnect action when their notification
//! server offers actions (GNOME and KDE do). Pressing it does what the
//! tray menu's Disconnect does.
//!
//! It also shows files sent through a desktop session
//! (SPEC-SESSION-FILES 4.7): "Jack sent you report.pdf
//! (Downloads/BMuster)", whose default action opens the folder with the
//! files selected (`org.freedesktop.FileManager1.ShowItems`, else
//! `xdg-open` on the folder). The files and folder are the tray's own
//! lookup, never paths from the notice file.

use futures_util::StreamExt as _;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use zbus::zvariant::Value;

const DESTINATION: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const ACTION: &str = "disconnect";
/// The default action: clicking the notification itself.
const OPEN: &str = "default";
const BODY: &str = "Disconnect ends every remote desktop session on this computer.";

/// One notification to show.
pub enum Note {
    /// Someone connected: Disconnect is offered.
    Viewer(String),
    /// Files arrived in `folder`; clicking selects `files` in it.
    Files {
        summary: String,
        folder: PathBuf,
        files: Vec<PathBuf>,
    },
}

/// Shows notifications on a thread of its own.
pub struct Notifier {
    send: UnboundedSender<Note>,
}

impl Notifier {
    /// Starts the notification thread; `disconnect` runs (on a blocking
    /// thread) when the person presses Disconnect on one.
    pub fn start(disconnect: fn()) -> Notifier {
        let (send, receive) = unbounded_channel();
        let started = std::thread::Builder::new()
            .name("tray notifications".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        log::warn!("Tray notifications unavailable: {error}");
                        return;
                    }
                };
                if let Err(error) = runtime.block_on(serve(receive, disconnect)) {
                    log::warn!("Tray notifications stopped: {error}");
                }
            });
        if let Err(error) = started {
            log::warn!("Could not start the tray notifications: {error}");
        }
        Notifier { send }
    }

    /// Shows `summary` (fails quietly when notifications are unavailable:
    /// the tray icon and title still say who is connected).
    pub fn show(&self, summary: String) {
        let _ = self.send.send(Note::Viewer(summary));
    }

    /// Shows a files notice (fails quietly, like a viewer's).
    pub fn files(&self, summary: String, folder: PathBuf, files: Vec<PathBuf>) {
        let _ = self.send.send(Note::Files {
            summary,
            folder,
            files,
        });
    }
}

/// Opens the folder with the files selected, in whatever file manager the
/// person has.
async fn show_files(connection: &zbus::Connection, folder: PathBuf, files: Vec<PathBuf>) {
    let uris: Vec<String> = files.iter().map(|file| file_uri(file)).collect();
    let shown = async {
        let manager = zbus::Proxy::new(
            connection,
            "org.freedesktop.FileManager1",
            "/org/freedesktop/FileManager1",
            "org.freedesktop.FileManager1",
        )
        .await?;
        manager.call::<_, _, ()>("ShowItems", &(uris, "")).await
    };
    if files.is_empty() || shown.await.is_err() {
        let _ = tokio::task::spawn_blocking(move || {
            std::process::Command::new("xdg-open")
                .arg(&folder)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map(drop)
        })
        .await;
    }
}

/// `file://` with every byte outside the unreserved set percent-encoded.
pub fn file_uri(path: &std::path::Path) -> String {
    use std::os::unix::ffi::OsStrExt as _;
    let mut uri = String::from("file://");
    for &byte in path.as_os_str().as_bytes() {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(byte as char);
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

async fn serve(mut summaries: UnboundedReceiver<Note>, disconnect: fn()) -> zbus::Result<()> {
    let connection = zbus::Connection::session().await?;
    let proxy = zbus::Proxy::new(&connection, DESTINATION, PATH, DESTINATION).await?;
    let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await?;
    let actions: Vec<&str> = if capabilities.iter().any(|c| c == "actions") {
        vec![ACTION, "Disconnect"]
    } else {
        Vec::new()
    };
    let mut invoked = proxy.receive_signal("ActionInvoked").await?;
    let open: Vec<&str> = if capabilities.iter().any(|c| c == "actions") {
        vec![OPEN, "Show"]
    } else {
        Vec::new()
    };
    let mut ours: HashSet<u32> = HashSet::new();
    let mut arrived: HashMap<u32, (PathBuf, Vec<PathBuf>)> = HashMap::new();
    loop {
        tokio::select! {
            note = summaries.recv() => {
                let Some(note) = note else { return Ok(()) };
                let hints: HashMap<&str, Value<'_>> = HashMap::new();
                match note {
                    Note::Viewer(summary) => {
                        let id: u32 = proxy
                            .call(
                                "Notify",
                                &("BMuster", 0u32, "bmuster", summary.as_str(), BODY, &actions, hints, -1i32),
                            )
                            .await?;
                        ours.insert(id);
                    }
                    Note::Files { summary, folder, files } => {
                        let id: u32 = proxy
                            .call(
                                "Notify",
                                &("BMuster", 0u32, "bmuster", summary.as_str(), "", &open, hints, -1i32),
                            )
                            .await?;
                        arrived.insert(id, (folder, files));
                    }
                }
            }
            Some(message) = invoked.next() => {
                let Ok((id, key)) = message.body().deserialize::<(u32, String)>() else {
                    continue;
                };
                if ours.contains(&id) && key == ACTION {
                    let _ = tokio::task::spawn_blocking(disconnect).await;
                }
                if key == OPEN {
                    if let Some((folder, files)) = arrived.remove(&id) {
                        show_files(&connection, folder, files).await;
                    }
                }
            }
        }
    }
}
