//! Windows: the service "BMuster Server" runs `bmuster-server run --service`
//! as LocalService, which may change only the data folder; Node's output
//! goes to `server.log` there (SPEC-SERVER-INSTALL I6).

use crate::config;
use crate::layout::Layout;
use crate::node;
use anyhow::{bail, Context as _, Result};
use bmuster_service::windows::{self as service, status, Account, ServiceSpec, LOCAL_SERVICE_SID};
use std::ffi::OsString;
use std::fs::File;
use std::io::Write as _;
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use windows_service::service::{ServiceControl, ServiceState};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

pub const SERVICE_NAME: &str = "BMusterServer";
const DISPLAY_NAME: &str = "BMuster Server";
const DESCRIPTION: &str = "BMuster's web console, API and relay for BMuster agents.";
const FIREWALL_RULE: &str = "BMuster Server";

pub fn service_spec(layout: &Layout) -> ServiceSpec {
    ServiceSpec {
        name: SERVICE_NAME,
        display_name: DISPLAY_NAME,
        description: DESCRIPTION,
        executable: layout.launcher(),
        arguments: vec![
            OsString::from("run"),
            OsString::from("--service"),
            OsString::from("--data-dir"),
            layout.data.clone().into_os_string(),
        ],
        account: Account::LocalService,
    }
}

/// LocalService may change the data folder; nobody else but SYSTEM and Administrators may read it.
pub fn data_grants() -> Vec<String> {
    vec![format!("*{LOCAL_SERVICE_SID}:(OI)(CI)M")]
}

pub fn firewall_rule_arguments(port: u16) -> Vec<String> {
    vec![
        "advfirewall".into(),
        "firewall".into(),
        "add".into(),
        "rule".into(),
        format!("name={FIREWALL_RULE}"),
        "dir=in".into(),
        "action=allow".into(),
        "protocol=TCP".into(),
        format!("localport={port}"),
    ]
}

fn remove_firewall_rule() {
    let _ = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "delete",
            "rule",
            &format!("name={FIREWALL_RULE}"),
        ])
        .output();
}

pub fn require_admin() -> Result<()> {
    service::require_admin()
}

pub fn install_service(layout: &Layout) -> Result<()> {
    service::restrict_dir(&layout.data, &data_grants())?;
    let listen = config::read_listen(&layout.env_file())?;
    remove_firewall_rule();
    let status = Command::new("netsh")
        .args(firewall_rule_arguments(listen.port))
        .stdout(Stdio::null())
        .status()
        .context("could not run netsh")?;
    if !status.success() {
        bail!("netsh could not open port {} ({status})", listen.port);
    }
    println!("Allowed TCP port {} through Windows Firewall.", listen.port);
    if service::exists(SERVICE_NAME) {
        service::stop_and_delete(SERVICE_NAME)?;
    }
    service::create_and_start(&service_spec(layout))?;
    println!("Installed and started the \"{DISPLAY_NAME}\" service.");
    Ok(())
}

pub fn stop_service() -> Result<bool> {
    service::stop(SERVICE_NAME)
}

pub fn service_installed() -> bool {
    service::exists(SERVICE_NAME)
}

pub fn remove_service() -> Result<()> {
    if service::stop_and_delete(SERVICE_NAME)? {
        println!("Removed the \"{DISPLAY_NAME}\" service.");
    }
    remove_firewall_rule();
    Ok(())
}

pub fn remove_user() -> Result<()> {
    Ok(())
}

/// Deletes the program folder. A running program cannot delete its own
/// file, so when this launcher lives there everything else goes now and a
/// detached `cmd` removes the folder a few seconds after it exits.
pub fn remove_program(layout: &Layout) -> Result<()> {
    let current = std::env::current_exe()?;
    if !current.starts_with(&layout.program) {
        return std::fs::remove_dir_all(&layout.program)
            .with_context(|| format!("could not remove {}", layout.program.display()));
    }
    for entry in std::fs::read_dir(&layout.program)? {
        let path = entry?.path();
        if path == current {
            continue;
        }
        if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        }
        .with_context(|| format!("could not remove {}", path.display()))?;
    }
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    Command::new("cmd.exe")
        .raw_arg(format!(
            "/d /c \"ping -n 4 127.0.0.1 >nul & rmdir /s /q \"{}\"\"",
            layout.program.display()
        ))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .context("could not schedule removing the program folder")?;
    Ok(())
}

pub fn service_state() -> String {
    service::state(SERVICE_NAME)
}

pub fn log_hint(layout: &Layout) -> String {
    format!(
        "{} (setup code: Select-String 'setup code' \"{}\" | Select-Object -Last 1)",
        layout.log_file().display(),
        layout.log_file().display()
    )
}

// ---------------------------------------------------------------------------
// Running under the service manager
// ---------------------------------------------------------------------------

static SERVICE_LAYOUT: OnceLock<Layout> = OnceLock::new();

define_windows_service!(ffi_service_main, service_main);

/// Hands this thread to the service manager; returns when the service stops.
pub fn run_as_service(layout: Layout) -> Result<()> {
    let _ = SERVICE_LAYOUT.set(layout);
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("could not start as a Windows service (start it with the service manager)")
}

fn note(log: &mut File, line: &str) {
    let _ = writeln!(log, "bmuster-server: {line}");
}

fn service_main(_arguments: Vec<OsString>) {
    let Some(layout) = SERVICE_LAYOUT.get() else {
        return;
    };
    let Ok(mut log) = bmuster_service::log_file::open_rotated(&layout.log_file()) else {
        return;
    };
    if let Err(e) = service_body(layout, &mut log) {
        note(&mut log, &format!("the service failed: {e:#}"));
    }
}

enum Signal {
    Stop,
}

fn service_body(layout: &Layout, log: &mut File) -> Result<()> {
    let (sender, signals) = mpsc::channel();
    let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = sender.send(Signal::Stop);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .context("could not register with the service manager")?;

    let mut child = node::command(layout)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log.try_clone()?)
        .spawn()
        .with_context(|| format!("could not start {}", layout.node().display()))?;
    handle.set_service_status(status(ServiceState::Running, 0))?;

    loop {
        match signals.recv_timeout(Duration::from_millis(500)) {
            Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Windows has no SIGTERM for a console-less child; SQLite's
                // write-ahead log keeps the database whole.
                let _ = child.kill();
                let _ = child.wait();
                note(log, "stopped");
                handle.set_service_status(status(ServiceState::Stopped, 0))?;
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(exit) = child.try_wait()? {
                    note(
                        log,
                        &format!("Node exited ({exit}); the service manager will restart it"),
                    );
                    // Ending without reporting "stopped" counts as a failure,
                    // so the failure actions start the service again.
                    std::process::exit(1);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_service_runs_the_launcher_as_local_service_with_the_data_folder() {
        let layout = Layout {
            program: PathBuf::from(r"C:\Program Files\BMuster Server"),
            data: PathBuf::from(r"C:\ProgramData\BMuster Server"),
        };
        let spec = service_spec(&layout);
        assert_eq!(spec.name, "BMusterServer");
        assert_eq!(spec.display_name, "BMuster Server");
        assert_eq!(spec.account, Account::LocalService);
        assert_eq!(
            spec.executable,
            PathBuf::from(r"C:\Program Files\BMuster Server\bmuster-server.exe")
        );
        assert_eq!(
            spec.arguments,
            vec![
                OsString::from("run"),
                OsString::from("--service"),
                OsString::from("--data-dir"),
                OsString::from(r"C:\ProgramData\BMuster Server"),
            ]
        );
        // Never the agent's service.
        assert_ne!(spec.name, "BMusterAgent");
    }

    #[test]
    fn local_service_may_change_the_data_and_the_port_is_opened() {
        assert_eq!(data_grants(), vec!["*S-1-5-19:(OI)(CI)M".to_string()]);
        assert_eq!(
            firewall_rule_arguments(8443).join(" "),
            "advfirewall firewall add rule name=BMuster Server dir=in action=allow protocol=TCP localport=8443"
        );
    }
}
