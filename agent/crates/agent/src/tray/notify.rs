//! The tray's desktop notification when a viewer connects (SPEC-DESKTOP
//! 8.2, notice version 2): `org.freedesktop.Notifications` on the person's
//! own session bus, with a Disconnect action when their notification
//! server offers actions (GNOME and KDE do). Pressing it does what the
//! tray menu's Disconnect does.

use futures_util::StreamExt as _;
use std::collections::{HashMap, HashSet};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use zbus::zvariant::Value;

const DESTINATION: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
const ACTION: &str = "disconnect";
const BODY: &str = "Disconnect ends every remote desktop session on this computer.";

/// Shows notifications on a thread of its own.
pub struct Notifier {
    send: UnboundedSender<String>,
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
        let _ = self.send.send(summary);
    }
}

async fn serve(mut summaries: UnboundedReceiver<String>, disconnect: fn()) -> zbus::Result<()> {
    let connection = zbus::Connection::session().await?;
    let proxy = zbus::Proxy::new(&connection, DESTINATION, PATH, DESTINATION).await?;
    let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await?;
    let actions: Vec<&str> = if capabilities.iter().any(|c| c == "actions") {
        vec![ACTION, "Disconnect"]
    } else {
        Vec::new()
    };
    let mut invoked = proxy.receive_signal("ActionInvoked").await?;
    let mut ours: HashSet<u32> = HashSet::new();
    loop {
        tokio::select! {
            summary = summaries.recv() => {
                let Some(summary) = summary else { return Ok(()) };
                let hints: HashMap<&str, Value<'_>> = HashMap::new();
                let id: u32 = proxy
                    .call(
                        "Notify",
                        &("BMuster", 0u32, "bmuster", summary.as_str(), BODY, &actions, hints, -1i32),
                    )
                    .await?;
                ours.insert(id);
            }
            Some(message) = invoked.next() => {
                let Ok((id, key)) = message.body().deserialize::<(u32, String)>() else {
                    continue;
                };
                if ours.contains(&id) && key == ACTION {
                    let _ = tokio::task::spawn_blocking(disconnect).await;
                }
            }
        }
    }
}
