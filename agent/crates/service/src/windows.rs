//! The Windows service manager: creating, stopping, deleting and reporting
//! on one service, the folder rules for its data, and the status values a
//! running service reports.

use anyhow::{bail, Context as _, Result};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use windows_service::service::{
    Service, ServiceAccess, ServiceAction, ServiceActionType, ServiceControlAccept,
    ServiceErrorControl, ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};

/// SID of LocalSystem (`NT AUTHORITY\SYSTEM`).
pub const SYSTEM_SID: &str = "S-1-5-18";
/// SID of `NT AUTHORITY\LocalService`.
pub const LOCAL_SERVICE_SID: &str = "S-1-5-19";
/// SID of the local Administrators group.
pub const ADMINISTRATORS_SID: &str = "S-1-5-32-544";

/// A Windows known folder from its environment variable; never guessed.
pub fn known_folder(variable: &str) -> Result<PathBuf> {
    match std::env::var_os(variable) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => bail!("the {variable} environment variable is not set"),
    }
}

pub fn manager(access: ServiceManagerAccess) -> Result<ServiceManager> {
    ServiceManager::local_computer(None::<&str>, access).context(
        "could not open the Windows service manager; run this from an Administrator prompt",
    )
}

/// Succeeds only for an Administrator (who may create services).
pub fn require_admin() -> Result<()> {
    manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE).map(|_| ())
}

/// The account a service runs as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Account {
    /// Full control of the machine (the agent, which manages it).
    LocalSystem,
    /// Few rights and no network identity (the server, which needs neither).
    LocalService,
}

/// What `create_and_start` registers.
pub struct ServiceSpec {
    /// Key name, no spaces, so `sc.exe` commands stay simple.
    pub name: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub executable: PathBuf,
    pub arguments: Vec<OsString>,
    pub account: Account,
}

/// The service manager's view of `spec`: starts with Windows, own process.
pub fn service_info(spec: &ServiceSpec) -> ServiceInfo {
    ServiceInfo {
        name: OsString::from(spec.name),
        display_name: OsString::from(spec.display_name),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: spec.executable.clone(),
        launch_arguments: spec.arguments.clone(),
        dependencies: vec![],
        account_name: match spec.account {
            Account::LocalSystem => None,
            Account::LocalService => Some(OsString::from(r"NT AUTHORITY\LocalService")),
        },
        account_password: None,
    }
}

/// Restart 10 s after each failure (forgotten after a day). A clean stop,
/// even with an exit code, is not a failure.
pub fn failure_actions() -> ServiceFailureActions {
    ServiceFailureActions {
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
    }
}

/// Registers the service with its description and restart rules, and starts it.
pub fn create_and_start(spec: &ServiceSpec) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE)?;
    let service = manager
        .create_service(
            &service_info(spec),
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START | ServiceAccess::QUERY_STATUS,
        )
        .context("could not create the service")?;
    service
        .set_description(spec.description)
        .context("could not describe the service")?;
    service
        .update_failure_actions(failure_actions())
        .context("could not set the service's restart rules")?;
    service
        .start::<&OsStr>(&[])
        .context("could not start the service")
}

/// What setting the rescue rules needs: changing the configuration, and
/// starting the service, because the rules include restarts.
pub const RESCUE_ACCESS: ServiceAccess = ServiceAccess::CHANGE_CONFIG.union(ServiceAccess::START);

/// After two restarts in five minutes, runs `command` (the agent's rescue
/// copy). Only crashes count: a clean stop with an exit code (a removed
/// machine) is not a failure.
pub fn set_rescue_actions(name: &str, command: &OsStr) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    // Windows refuses restart actions ("Access is denied") unless the handle
    // may also start the service (ChangeServiceConfig2, SC_ACTION_RESTART).
    let service = manager
        .open_service(name, RESCUE_ACCESS)
        .context("could not open the service")?;
    let restart = ServiceAction {
        action_type: ServiceActionType::Restart,
        delay: Duration::from_secs(10),
    };
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(300)),
            reboot_msg: None,
            command: Some(command.to_os_string()),
            actions: Some(vec![
                restart.clone(),
                restart,
                ServiceAction {
                    action_type: ServiceActionType::RunCommand,
                    delay: Duration::from_secs(1),
                },
            ]),
        })
        .context("could not set the service's rescue rules")
}

pub fn exists(name: &str) -> bool {
    manager(ServiceManagerAccess::CONNECT)
        .and_then(|manager| {
            manager
                .open_service(name, ServiceAccess::QUERY_STATUS)
                .map_err(anyhow::Error::from)
        })
        .is_ok()
}

fn wait_for(service: &Service, state: ServiceState) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while service.query_status()?.current_state != state {
        if Instant::now() > deadline {
            bail!("the service did not reach {state:?} within 30 s");
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

fn stop_and_wait(service: &Service) -> Result<bool> {
    if service.query_status()?.current_state == ServiceState::Stopped {
        return Ok(false);
    }
    service.stop().context("could not stop the service")?;
    wait_for(service, ServiceState::Stopped)?;
    Ok(true)
}

/// Stops the service if it runs; returns whether it was running.
pub fn stop(name: &str) -> Result<bool> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(name, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP)
    else {
        return Ok(false);
    };
    stop_and_wait(&service)
}

pub fn start(name: &str) -> Result<()> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let service = manager
        .open_service(name, ServiceAccess::QUERY_STATUS | ServiceAccess::START)
        .context("could not open the service")?;
    service
        .start::<&OsStr>(&[])
        .context("could not start the service")
}

/// Stops and deletes the service; false when there was none.
pub fn stop_and_delete(name: &str) -> Result<bool> {
    let manager = manager(ServiceManagerAccess::CONNECT)?;
    let Ok(service) = manager.open_service(
        name,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) else {
        return Ok(false);
    };
    stop_and_wait(&service)?;
    service.delete().context("could not delete the service")?;
    Ok(true)
}

/// One word for `status`: running, stopped, … or "not installed".
pub fn state(name: &str) -> String {
    let Ok(manager) = manager(ServiceManagerAccess::CONNECT) else {
        return "unknown (could not open the service manager)".into();
    };
    match manager.open_service(name, ServiceAccess::QUERY_STATUS) {
        Err(_) => "not installed".into(),
        Ok(service) => match service.query_status() {
            Ok(status) => format!("{:?}", status.current_state).to_lowercase(),
            Err(e) => format!("unknown ({e})"),
        },
    }
}

/// The `icacls` arguments that give SYSTEM and Administrators full control
/// of `dir` and everything in it, plus `extra` (`*<SID>:(OI)(CI)<rights>`),
/// and drop every inherited rule.
pub fn restrict_dir_arguments(dir: &Path, extra: &[String]) -> Vec<OsString> {
    let mut arguments = vec![dir.as_os_str().to_owned(), "/inheritance:r".into()];
    let grants = [
        format!("*{SYSTEM_SID}:(OI)(CI)F"),
        format!("*{ADMINISTRATORS_SID}:(OI)(CI)F"),
    ];
    for grant in grants.iter().chain(extra) {
        arguments.push("/grant:r".into());
        arguments.push(grant.into());
    }
    arguments
}

/// Restricts `dir` as [`restrict_dir_arguments`] describes.
pub fn restrict_dir(dir: &Path, extra: &[String]) -> Result<()> {
    let status = Command::new("icacls")
        .args(restrict_dir_arguments(dir, extra))
        .status()
        .context("could not run icacls")?;
    if !status.success() {
        bail!("icacls could not restrict {} ({status})", dir.display());
    }
    Ok(())
}

/// What a running service reports: stop and shutdown are accepted while it
/// runs; a non-zero exit code is service-specific.
pub fn status(state: ServiceState, exit_code: u32) -> ServiceStatus {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A restart action needs SERVICE_START on the handle; without it Windows
    /// 10 refused the installer with "Access is denied" (os error 5).
    #[test]
    fn rescue_rules_open_the_service_with_start_access() {
        assert!(RESCUE_ACCESS.contains(ServiceAccess::CHANGE_CONFIG));
        assert!(RESCUE_ACCESS.contains(ServiceAccess::START));
    }

    fn spec(account: Account) -> ServiceSpec {
        ServiceSpec {
            name: "BMusterTest",
            display_name: "BMuster Test",
            description: "A test.",
            executable: PathBuf::from(r"C:\Program Files\BMuster Test\test.exe"),
            arguments: vec!["run".into(), "--service".into()],
            account,
        }
    }

    #[test]
    fn services_start_with_windows_under_the_chosen_account() {
        let system = service_info(&spec(Account::LocalSystem));
        assert_eq!(system.start_type, ServiceStartType::AutoStart);
        assert_eq!(system.account_name, None);
        assert_eq!(
            system.launch_arguments,
            vec![OsString::from("run"), OsString::from("--service")]
        );
        let local = service_info(&spec(Account::LocalService));
        assert_eq!(
            local.account_name,
            Some(OsString::from(r"NT AUTHORITY\LocalService"))
        );
        assert_eq!(local.account_password, None);
    }

    #[test]
    fn failures_restart_after_ten_seconds() {
        let actions = failure_actions().actions.unwrap();
        assert_eq!(actions.len(), 3);
        assert!(actions.iter().all(|action| {
            action.action_type == ServiceActionType::Restart
                && action.delay == Duration::from_secs(10)
        }));
    }

    #[test]
    fn data_folders_drop_inherited_rules() {
        let arguments = restrict_dir_arguments(
            Path::new(r"C:\Data"),
            &[format!("*{LOCAL_SERVICE_SID}:(OI)(CI)M")],
        );
        let text: Vec<String> = arguments
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            text,
            [
                r"C:\Data",
                "/inheritance:r",
                "/grant:r",
                "*S-1-5-18:(OI)(CI)F",
                "/grant:r",
                "*S-1-5-32-544:(OI)(CI)F",
                "/grant:r",
                "*S-1-5-19:(OI)(CI)M"
            ]
        );
    }
}
