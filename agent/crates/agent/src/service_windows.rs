//! Windows install: binary in C:\Program Files\BMuster, data and log in
//! C:\ProgramData\BMuster, service "BMuster Agent" running as LocalSystem.
//! The service is the launcher; it runs the agent from
//! C:\ProgramData\BMuster\versions\current (SPEC-AGENT-UPDATES). The
//! Program Files binary is also the rescue copy (SPEC-SERVER-UPDATES): the
//! service's recovery actions run its `rescue` after repeated crashes, and a
//! version healthy for a day copies itself over it. (Windows cannot rename
//! the folder of a running program, so unlike Linux the service does not
//! run `versions\current` itself.)

use crate::client::TlsMode;
use crate::identity::{self, EnrolOptions};
use crate::launcher::{Ended, Launcher};
use crate::paths;
use crate::sessions::windows_desktop::sas;
use crate::{rescue, updates};
use anyhow::{Context as _, Result};
use bmuster_protocol::ServerTrust;
use bmuster_service::windows::{self as service, status, Account, ServiceSpec};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows_service::service::{ServiceControl, ServiceState};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::{define_windows_service, service_dispatcher};

/// Service key name (no spaces, so `sc.exe` commands stay simple).
pub const SERVICE_NAME: &str = "BMusterAgent";
const DISPLAY_NAME: &str = "BMuster Agent";
const DESCRIPTION: &str = "Reports this machine to its BMuster server.";
pub const REVOKED_EXIT_CODE: u32 = 3;
const ERROR_EXIT_CODE: u32 = 1;
const LOG_FILE: &str = "agent.log";

fn install_dir() -> Result<PathBuf> {
    Ok(service::known_folder("ProgramFiles")?.join("BMuster"))
}

/// The installed program: the service's launcher, the rescue copy, and the
/// tray every user runs (SPEC-TRAY-SESSIONS).
pub fn binary_path() -> Result<PathBuf> {
    Ok(install_dir()?.join("bmuster-agent.exe"))
}

pub fn log_path() -> Result<PathBuf> {
    Ok(paths::default_data_dir()?.join(LOG_FILE))
}

pub fn install(url: &str, code: &str, name: Option<&str>, trust: ServerTrust) -> Result<()> {
    service::require_admin()?;
    // A fresh install replaces any earlier agent completely (service, program,
    // identity), so a half-finished or old install never gets in the way.
    if service::exists(SERVICE_NAME)
        || install_dir()?.exists()
        || paths::default_data_dir()?.exists()
    {
        log::info!(
            "Found an earlier BMuster Agent on this machine; removing it before installing."
        );
        uninstall(true)?;
    }

    let binary = binary_path()?;
    crate::tray::windows::install(&binary)?;
    let current = std::env::current_exe().context("could not find this program's path")?;
    std::fs::create_dir_all(install_dir()?).context("could not create the program folder")?;
    if current.canonicalize().ok() != binary.canonicalize().ok() {
        std::fs::copy(&current, &binary)
            .with_context(|| format!("could not copy the agent to {}", binary.display()))?;
    }
    log::info!("Copied the agent to {}", binary.display());

    let data_dir = paths::default_data_dir()?;
    identity::prepare_data_dir(&data_dir)?;
    // Only SYSTEM and Administrators may read the data folder (it holds the key).
    service::restrict_dir(&data_dir, &[])?;
    identity::enrol(
        &data_dir,
        &EnrolOptions {
            url,
            code,
            name,
            tls: TlsMode::Checked(trust),
        },
    )?;

    // Ctrl+Alt+Del from the console needs the SoftwareSASGeneration policy
    // to allow services; uninstall puts back what was there.
    if let Err(e) = sas::allow_services(&data_dir) {
        log::warn!("Ctrl+Alt+Del from the console will not work: {e:#}");
    }

    let bytes =
        std::fs::read(&binary).with_context(|| format!("could not read {}", binary.display()))?;
    updates::seed_current(&updates::Layout::new(&data_dir), &bytes, updates::VERSION)?;
    rescue::record_version(&data_dir, updates::VERSION)?;

    // Restarts after a crash; a clean stop with the revoked exit code is not
    // a failure, so a removed machine stays stopped.
    service::create_and_start(&ServiceSpec {
        name: SERVICE_NAME,
        display_name: DISPLAY_NAME,
        description: DESCRIPTION,
        executable: binary,
        arguments: vec![OsString::from("launch"), OsString::from("--service")],
        account: Account::LocalSystem,
    })?;
    service::set_rescue_actions(SERVICE_NAME, &rescue_command()?)?;
    log::info!("Installed and started the \"{DISPLAY_NAME}\" service.");
    Ok(())
}

/// The recovery action's command line: the rescue copy's `rescue`.
fn rescue_command() -> Result<OsString> {
    let mut command = OsString::from("\"");
    command.push(binary_path()?);
    command.push("\" rescue");
    Ok(command)
}

pub fn uninstall(purge: bool) -> Result<()> {
    service::require_admin()?;
    crate::tray::windows::uninstall()?;
    if service::stop_and_delete(SERVICE_NAME)? {
        log::info!("Removed the \"{DISPLAY_NAME}\" service.");
    }
    // Tray helpers run the program in each session; end them so its folder
    // can go (the service, whose starter would start them again, is gone).
    let ended = crate::tray::windows_starter::stop_helpers(&binary_path()?);
    if ended > 0 {
        log::info!("Closed the BMuster tray in {ended} session(s).");
    }

    let dir = install_dir()?;
    let current = std::env::current_exe()?;
    if dir.exists() {
        if current.starts_with(&dir) {
            log::warn!(
                "This program is running from {}; delete that folder by hand once it exits.",
                dir.display()
            );
        } else {
            std::fs::remove_dir_all(&dir)
                .with_context(|| format!("could not remove {}", dir.display()))?;
            log::info!("Removed {}.", dir.display());
        }
    }
    let data_dir = paths::default_data_dir()?;
    if let Err(e) = sas::restore_policy(&data_dir) {
        log::warn!("Could not put back the Ctrl+Alt+Del policy: {e:#}");
    }
    crate::updates::remove_versions(&data_dir)?;
    if purge && data_dir.exists() {
        std::fs::remove_dir_all(&data_dir)
            .with_context(|| format!("could not remove {}", data_dir.display()))?;
        log::info!("Removed {} (identity, key and log).", data_dir.display());
    } else if data_dir.exists() {
        log::info!(
            "Kept {} (identity, key and log); add --purge to remove it.",
            data_dir.display()
        );
    }
    Ok(())
}

pub fn require_admin() -> Result<()> {
    service::require_admin()
}

/// Stops the service if it runs; returns whether it was running (`rejoin`).
pub fn stop_service() -> Result<bool> {
    service::stop(SERVICE_NAME)
}

pub fn start_service() -> Result<()> {
    service::start(SERVICE_NAME)
}

/// After `rescue` (run by the recovery action, with the service stopped).
pub fn finish_rescue() -> Result<()> {
    service::start(SERVICE_NAME)
}

/// From the worker, which runs as SYSTEM outside any sandbox.
pub fn refresh_rescue_copy() -> Result<()> {
    refresh_service()
}

/// `refresh-rescue`: the current version becomes the rescue copy (and the
/// service's launcher from its next start), and the recovery actions are
/// set, which also moves an install from before the rescue copy onto it.
pub fn refresh_service() -> Result<()> {
    service::require_admin()?;
    let program = std::env::current_exe().context("could not find this program's path")?;
    let data_dir = paths::default_data_dir()?;
    rescue::refresh(&data_dir, &program, &binary_path()?, updates::VERSION)?;
    service::set_rescue_actions(SERVICE_NAME, &rescue_command()?)?;
    log::info!("Version {} is the rescue copy now.", updates::VERSION);
    Ok(())
}

/// The local page's Uninstall, from inside the service: a copy of this
/// program outside the program folder (so that folder can be deleted) runs
/// `uninstall --purge` a few seconds later, after the page has replied. It
/// stops this service first. The copy in the temp folder stays behind.
pub fn schedule_uninstall() -> Result<()> {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let program = std::env::current_exe().context("could not find this program's path")?;
    let copy = std::env::temp_dir().join("bmuster-agent-uninstall.exe");
    std::fs::copy(&program, &copy)
        .with_context(|| format!("could not copy the agent to {}", copy.display()))?;
    Command::new("cmd.exe")
        .raw_arg(format!(
            "/d /c \"ping -n 4 127.0.0.1 >nul & \"{}\" uninstall --purge\"",
            copy.display()
        ))
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .context("could not start the uninstall")?;
    Ok(())
}

pub fn service_state() -> String {
    service::state(SERVICE_NAME)
}

// ---------------------------------------------------------------------------
// Running under the service manager
// ---------------------------------------------------------------------------

define_windows_service!(ffi_service_main, service_main);

/// Hands this thread to the service manager; returns when the service stops.
pub fn run_as_service() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("could not start as a Windows service (start it with the service manager)")
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(e) = service_body() {
        log::error!("The service failed: {e:#}");
    }
}

fn service_body() -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);
    let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            stop_flag.store(true, Ordering::SeqCst);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .context("could not register with the service manager")?;
    handle.set_service_status(status(ServiceState::Running, 0))?;

    // The launcher stops the agent (it has no console to signal) when asked.
    let ended = Launcher::new(paths::default_data_dir()?, Vec::new())
        .and_then(|launcher| launcher.run(&stop));
    let exit_code = match ended {
        Ok(Ended::Stopped) => 0,
        Ok(Ended::Revoked) => REVOKED_EXIT_CODE,
        Err(e) => {
            log::error!("{e:#}");
            ERROR_EXIT_CODE
        }
    };
    handle.set_service_status(status(ServiceState::Stopped, exit_code))?;
    Ok(())
}
