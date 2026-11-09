//! `bmuster-server`: runs the bundled Node server, installs it as a service,
//! and updates the whole install as root. See `docs/specs/SPEC-SERVER-INSTALL.md`
//! and `docs/specs/SPEC-SERVER-UPDATES.md`.

mod address;
mod bundle;
mod config;
mod install;
mod launcher;
mod layout;
mod releases;
#[cfg(target_os = "linux")]
mod service_linux;
#[cfg(windows)]
mod service_windows;
mod updater;
mod updates;

use anyhow::{bail, Result};
use clap::{Args, Parser, Subcommand};
use layout::Layout;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "bmuster-server", version, about = "BMuster server launcher")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Folders {
    /// Program folder (default: /opt/bmuster-server or C:\Program Files\BMuster Server)
    #[arg(long, value_name = "DIR")]
    prefix: Option<PathBuf>,
    /// Data folder (default: /var/lib/bmuster-server or C:\ProgramData\BMuster Server)
    #[arg(long, value_name = "DIR")]
    data_dir: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the server in the foreground (and as the Linux service)
    Run {
        /// Data folder (default: /var/lib/bmuster-server or C:\ProgramData\BMuster Server)
        #[arg(long, value_name = "DIR")]
        data_dir: Option<PathBuf>,
        /// Started by the Windows service manager
        #[cfg(windows)]
        #[arg(long, hide = true)]
        service: bool,
    },
    /// Copy this bundle into place, write the settings once, and start the
    /// service (needs root or Administrator unless --no-service)
    Install {
        #[command(flatten)]
        folders: Folders,
        /// Port for a new settings file (an existing one keeps its port)
        #[arg(long, value_name = "PORT")]
        port: Option<u16>,
        /// Install the files and settings only: no service, no system user, no root
        #[arg(long)]
        no_service: bool,
        /// Only rewrite the service definitions for this release (the updater
        /// runs this from the new release)
        #[arg(long)]
        refresh_units: bool,
    },
    /// Install the newest signed release if the console asked for one (run
    /// as root by the update service, or every two minutes on Windows)
    Update {
        #[command(flatten)]
        folders: Folders,
        /// Only finish or undo an interrupted update (at boot)
        #[arg(long)]
        recover: bool,
    },
    /// Stop and remove the service and the program folder (data is kept)
    Uninstall {
        #[command(flatten)]
        folders: Folders,
        /// Also delete the data folder (database, settings and secrets key)
        #[arg(long)]
        purge: bool,
    },
    /// Show the version, folders, service state and address
    Status {
        #[command(flatten)]
        folders: Folders,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    #[cfg(windows)]
    if let Command::Run {
        service: true,
        data_dir,
    } = &cli.command
    {
        return report(
            data_dir_or_default(data_dir.clone())
                .and_then(service_windows::run_as_service)
                .map(|()| ExitCode::SUCCESS),
        );
    }
    report(dispatch(cli.command))
}

fn report(result: Result<ExitCode>) -> ExitCode {
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("bmuster-server: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn data_dir_or_default(given: Option<PathBuf>) -> Result<PathBuf> {
    match given {
        Some(dir) => Ok(dir),
        None => layout::default_data_dir(),
    }
}

fn dispatch(command: Command) -> Result<ExitCode> {
    match command {
        Command::Run { data_dir, .. } => {
            run(data_dir_or_default(data_dir)?)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Install {
            folders,
            port,
            no_service,
            refresh_units,
        } => {
            let target = layout::resolve(folders.prefix, folders.data_dir)?;
            if refresh_units {
                install::refresh_units(&target, no_service)?;
            } else {
                install::install(&target, port, no_service)?;
            }
            Ok(ExitCode::SUCCESS)
        }
        Command::Update { folders, recover } => {
            update(&layout::resolve(folders.prefix, folders.data_dir)?, recover)
        }
        Command::Uninstall { folders, purge } => {
            install::uninstall(&layout::resolve(folders.prefix, folders.data_dir)?, purge)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Status { folders } => {
            install::status(&layout::resolve(folders.prefix, folders.data_dir)?);
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// Node in the foreground, restarted if it crashes; SIGTERM stops it.
fn run(data: PathBuf) -> Result<()> {
    let env_file = data.join(layout::ENV_FILE);
    if !env_file.exists() {
        bail!(
            "there are no settings at {}; run `bmuster-server install` first",
            env_file.display()
        );
    }
    #[cfg(unix)]
    {
        launcher::run_in_foreground(data)
    }
    #[cfg(not(unix))]
    {
        let stop = std::sync::atomic::AtomicBool::new(false);
        launcher::Launcher::for_this_program(data)?.run(&stop, None)
    }
}

fn update(target: &Layout, recover: bool) -> Result<ExitCode> {
    let keys = updates::trusted_keys()?;
    let service = updater::system::service(target)?;
    let source = updater::system::source();
    let updater = updater::Updater {
        layout: target,
        keys: &keys,
        target: updates::TARGET,
        service: service.as_ref(),
        source: source.as_ref(),
        health_window: updater::system::health_window(),
    };
    let outcome = if recover {
        updater.recover_at_boot()?
    } else {
        updater.update()?
    };
    println!("bmuster-server update: {outcome:?}");
    Ok(match outcome {
        updater::Outcome::Failed => ExitCode::FAILURE,
        _ => ExitCode::SUCCESS,
    })
}

#[cfg(target_os = "linux")]
mod platform {
    pub use crate::service_linux::{
        install_service, log_hint, refresh_units, remove_program, remove_service, remove_user,
        require_admin, service_installed, service_state, start_service, stop_service,
    };
}

#[cfg(windows)]
mod platform {
    pub use crate::service_windows::{
        install_service, log_hint, refresh_units, remove_program, remove_service, remove_user,
        require_admin, service_installed, service_state, start_service, stop_service,
    };
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use crate::layout::Layout;
    use anyhow::{bail, Context as _, Result};

    pub fn require_admin() -> Result<()> {
        bail!("installing a service is supported on Linux and Windows only; use --no-service")
    }

    pub fn install_service(_layout: &Layout) -> Result<()> {
        require_admin()
    }

    pub fn refresh_units(_layout: &Layout) -> Result<()> {
        require_admin()
    }

    pub fn stop_service() -> Result<bool> {
        Ok(false)
    }

    pub fn start_service() -> Result<()> {
        require_admin()
    }

    pub fn service_installed() -> bool {
        false
    }

    pub fn remove_service() -> Result<()> {
        Ok(())
    }

    pub fn remove_user() -> Result<()> {
        Ok(())
    }

    pub fn remove_program(layout: &Layout) -> Result<()> {
        std::fs::remove_dir_all(&layout.program)
            .with_context(|| format!("could not remove {}", layout.program.display()))
    }

    pub fn service_state() -> String {
        "not supported on this system".into()
    }

    pub fn log_hint(_layout: &Layout) -> String {
        "the terminal it runs in".into()
    }
}
