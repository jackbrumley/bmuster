//! StatusNotifierItem in the user's bus; no GTK or privileged process.
use super::status;
use anyhow::Result;
use ksni::blocking::TrayMethods as _;
use ksni::menu::StandardItem;
use ksni::{Icon, MenuItem, Tray};

struct AgentTray {
    state: String,
    enabled: bool,
    clipboard: Option<arboard::Clipboard>,
}

impl AgentTray {
    fn refresh(&mut self) {
        match status::read() {
            Ok(snapshot) => {
                self.state = snapshot.state.label().into();
                self.enabled = true;
            }
            Err(error) => {
                self.state = format!("Agent not running: {error:#}");
                self.enabled = false;
            }
        }
    }
    fn action(&mut self, copy: bool) {
        let result = if copy {
            super::copy_url(&mut self.clipboard)
        } else {
            super::open_management()
        };
        if let Err(error) = result {
            self.state = format!(
                "Cannot {}: {error:#}",
                if copy { "copy URL" } else { "open management" }
            );
            log::warn!("{}", self.state);
        }
    }
}

impl Tray for AgentTray {
    fn id(&self) -> String {
        "org.bmuster.Agent".into()
    }
    fn title(&self) -> String {
        format!("BMuster: {}", self.state)
    }
    fn icon_pixmap(&self) -> Vec<Icon> {
        super::ICONS
            .iter()
            .map(|(edge, pixels)| Icon {
                width: *edge,
                height: *edge,
                data: pixels.to_vec(),
            })
            .collect()
    }
    fn activate(&mut self, _: i32, _: i32) {
        self.action(false);
    }
    fn menu(&self) -> Vec<MenuItem<Self>> {
        vec![
            StandardItem {
                label: format!("BMuster: {}", self.state),
                enabled: false,
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Open local management".into(),
                enabled: self.enabled,
                activate: Box::new(|tray: &mut Self| tray.action(false)),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Copy local URL".into(),
                enabled: self.enabled,
                activate: Box::new(|tray: &mut Self| tray.action(true)),
                ..Default::default()
            }
            .into(),
        ]
    }
    fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
        log::warn!("No tray host ({reason:?}); use BMuster in the applications menu to open local management");
        true
    }
}

pub fn run() -> Result<()> {
    let mut tray = AgentTray {
        state: String::new(),
        enabled: false,
        clipboard: None,
    };
    tray.refresh();
    let handle = tray.assume_sni_available(true).spawn()?;
    while !handle.is_closed() {
        std::thread::sleep(std::time::Duration::from_secs(5));
        handle.update(AgentTray::refresh);
    }
    Ok(())
}

pub fn shortcuts() -> [(&'static str, &'static str); 2] {
    [
        ("/etc/xdg/autostart/bmuster-agent.desktop", "[Desktop Entry]\nType=Application\nName=BMuster Agent\nComment=Show the BMuster connection status\nExec=/opt/bmuster/bmuster-agent tray\nIcon=network-workgroup\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"),
        ("/usr/share/applications/bmuster-agent.desktop", "[Desktop Entry]\nType=Application\nName=BMuster\nComment=Open this computer's BMuster management page\nExec=/opt/bmuster/bmuster-agent tray --open\nIcon=network-workgroup\nTerminal=false\nCategories=System;RemoteAccess;\n"),
    ]
}

pub fn install() -> Result<()> {
    for (path, content) in shortcuts() {
        let path = std::path::Path::new(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    for (path, _) in shortcuts() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn tray_shortcuts_and_autostart() {
        let entries = super::shortcuts();
        assert!(entries[0]
            .1
            .contains("Exec=/opt/bmuster/bmuster-agent tray\n"));
        assert!(entries[1].1.contains("tray --open\n"));
        for (_, content) in entries {
            assert!(!content.contains("sudo"));
            assert!(!content.contains(" launch"));
        }
    }
}
