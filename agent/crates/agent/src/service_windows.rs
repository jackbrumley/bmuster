//! Windows install: binary in C:\Program Files\BMuster, data and log in
//! C:\ProgramData\BMuster, service "BMuster Agent" running as LocalSystem.

use crate::client::TlsMode;
use crate::identity::{self, EnrolOptions};
use crate::paths;
use crate::status::RunMode;
use crate::worker::{self, Outcome, RunOptions, Signal};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::ServerTrust;
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

/// Service key name (no spaces, so `sc.exe` commands stay simple).
pub const SERVICE_NAME: &str = "BMusterAgent";
const DISPLAY_NAME: &str = "BMuster Agent";
const DESCRIPTION: &str = "Reports this machine to its BMuster server.";
pub const REVOKED_EXIT_CODE: u32 = 3;
/// The process exits with this without telling the service manager it
/// stopped, which counts as a failure, so the failure actions start it again.
pub const RESTART_EXIT_CODE: i32 = 4;
const ERROR_EXIT_CODE: u32 = 1;
const LOG_FILE: &str = "agent.log";

fn install_dir() -> Result<PathBuf> {
    Ok(paths::windows_dir("ProgramFiles")?.join("BMuster"))
}

fn binary_path() -> Result<PathBuf> {
    Ok(install_dir()?.join("bmuster-agent.exe"))
}

pub fn log_path() -> Result<PathBuf> {
    Ok(paths::default_data_dir()?.join(LOG_FILE))
}

fn manager(access: ServiceManagerAccess) -> Result<ServiceManager> {
    ServiceManager::local_computer(None::<&str>, access).context(
        "could not open the Windows service manager; run this from an Administrator prompt",
    )
}

/// Only SYSTEM and Administrators may read the data folder (it holds the key).
fn restrict_data_dir(dir: &std::path::Path) -> Result<()> {
    let status = Command::new("icacls")
        .arg(dir)
        .args([
            "/inheritance:r",
            "/grant:r",
            "*S-1-5-18:(OI)(CI)F",
            "/grant:r",
            "*S-1-5-32-544:(OI)(CI)F",
        ])
        .status()
        .context("could not run icacls")?;
    if !status.success() {
        bail!("icacls could not restrict {} ({status})", dir.display());
    }
    Ok(())
}

pub fn install(url: &str, code: &str, name: Option<&str>, trust: ServerTrust) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
    // A fresh install replaces any earlier agent completely (service, program,
    // identity), so a half-finished or old install never gets in the way.
    if manager
        .open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS)
        .is_ok()
        || install_dir()?.exists()
        || paths::default_data_dir()?.exists()
    {
        log::info!(
            "Found an earlier BMuster agent on this machine; removing it before installing."
        );
        uninstall(true)?;
    }

    let binary = binary_path()?;
    let current = std::env::current_exe().context("could not find this program's path")?;
    std::fs::create_dir_all(install_dir()?).context("could not create the program folder")?;
    if current.canonicalize().ok() != binary.canonicalize().ok() {
        std::fs::copy(&current, &binary)
            .with_context(|| format!("could not copy the agent to {}", binary.display()))?;
    }
    log::info!("Copied the agent to {}", binary.display());

    let data_dir = paths::default_data_dir()?;
    identity::prepare_data_dir(&data_dir)?;
    restrict_data_dir(&data_dir)?;
    identity::enrol(
        &data_dir,
        &EnrolOptions {
            url,
            code,
            name,
            tls: TlsMode::Checked(trust),
        },
    )?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: binary,
        launch_arguments: vec![OsString::from("run"), OsString::from("--service")],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let service = manager
        .create_service(
            &info,
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        )
        .context("could not create the service")?;
    service
        .set_description(DESCRIPTION)
        .context("could not describe the service")?;
    // Restart after a crash; a clean stop with the revoked exit code is not a
    // failure, so a removed machine stays stopped.
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(10),
                };
                3
            ]),
        })
        .context("could not set the service's restart rules")?;
    service
        .start::<&OsStr>(&[])
        .context("could not start the service")?;
    log::info!("Installed and started the \"{DISPLAY_NAME}\" service.");
    Ok(())
}

pub fn uninstall(purge: bool) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    if let Ok(service) = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        if service.query_status()?.current_state != ServiceState::Stopped {
            service.stop().context("could not stop the service")?;
            let deadline = Instant::now() + Duration::from_secs(30);
            while service.query_status()?.current_state != ServiceState::Stopped {
                if Instant::now() > deadline {
                    bail!("the service did not stop within 30 s");
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        service.delete().context("could not delete the service")?;
        log::info!("Removed the \"{DISPLAY_NAME}\" service.");
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
    manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE).map(|_| ())
}

fn wait_for(service: &windows_service::service::Service, state: ServiceState) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while service.query_status()?.current_state != state {
        if Instant::now() > deadline {
            bail!("the service did not reach {state:?} within 30 s");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

/// Stops the service if it runs; returns whether it was running (`rejoin`).
pub fn stop_service() -> Result<bool> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP,
    ) else {
        return Ok(false);
    };
    if service.query_status()?.current_state == ServiceState::Stopped {
        return Ok(false);
    }
    service.stop().context("could not stop the service")?;
    wait_for(&service, ServiceState::Stopped)?;
    Ok(true)
}

pub fn start_service() -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::QUERY_STATUS | ServiceAccess::START,
        )
        .context("could not open the service")?;
    service
        .start::<&OsStr>(&[])
        .context("could not start the service")
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
    let Ok(manager) = manager(ServiceManagerAccess::CONNECT) else {
        return "unknown (could not open the service manager)".into();
    };
    match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS) {
        Err(_) => "not installed".into(),
        Ok(service) => match service.query_status() {
            Ok(status) => format!("{:?}", status.current_state).to_lowercase(),
            Err(e) => format!("unknown ({e})"),
        },
    }
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

fn status(state: ServiceState, exit_code: u32) -> ServiceStatus {
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: if exit_code == 0 {
            ServiceExitCode::Win32(0)
        } else {
            ServiceExitCode::ServiceSpecific(exit_code)
        },
        checkpoint: 0,
        wait_hint: Duration::from_secs(10),
        process_id: None,
    }
}

fn service_main(_arguments: Vec<OsString>) {
    if let Err(e) = service_body() {
        log::error!("The service failed: {e:#}");
    }
}

fn service_body() -> Result<()> {
    let (sender, signals) = mpsc::channel();
    let stop_sender = sender.clone();
    let handle = service_control_handler::register(SERVICE_NAME, move |control| match control {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            let _ = stop_sender.send(Signal::Stop);
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    })
    .context("could not register with the service manager")?;
    handle.set_service_status(status(ServiceState::Running, 0))?;

    let options = RunOptions {
        data_dir: paths::default_data_dir()?,
        insecure_dev_tls: false,
        mode: RunMode::Service,
        local_page_port: None,
    };
    let exit_code = match worker::run(&options, sender, signals) {
        Ok(Outcome::Stopped) => 0,
        Ok(Outcome::Revoked) => REVOKED_EXIT_CODE,
        Ok(Outcome::Restart) => {
            log::info!("Restarting through the service manager.");
            log::logger().flush();
            std::process::exit(RESTART_EXIT_CODE);
        }
        Err(e) => {
            log::error!("{e:#}");
            ERROR_EXIT_CODE
        }
    };
    handle.set_service_status(status(ServiceState::Stopped, exit_code))?;
    Ok(())
}
