//! `bmuster-agent`: enrols a machine with a BMuster server, checks in, and
//! keeps a live socket open. See `docs/specs/SPEC-ENROLMENT.md`.

mod client;
mod identity;
mod inventory;
mod logging;
mod paths;
#[cfg(target_os = "linux")]
mod service_linux;
#[cfg(windows)]
mod service_windows;
mod socket;
mod worker;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use client::TlsMode;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::mpsc;

/// Exit code when the server has removed this machine (distinct from a crash).
const EXIT_REVOKED: u8 = 3;

#[derive(Parser)]
#[command(name = "bmuster-agent", version, about = "BMuster agent")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Args)]
struct Join {
    /// Server address, for example https://bmuster.example.com
    #[arg(long)]
    url: String,
    /// Join code from the console's Add machine page, like K7P-4QX-29M
    #[arg(long)]
    code: String,
    /// Name shown in the console (default: this machine's hostname)
    #[arg(long)]
    name: Option<String>,
}

#[derive(Subcommand)]
enum Command {
    /// Copy the agent into place, enrol, and start the service (needs root or Administrator)
    Install(Join),
    /// Enrol only, without installing a service (for development)
    Enrol {
        #[command(flatten)]
        join: Join,
        /// Data folder (default: /var/lib/bmuster or C:\ProgramData\BMuster)
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// DEVELOPMENT ONLY: accept any TLS certificate from the server
        #[arg(long)]
        insecure_dev_tls: bool,
    },
    /// Run the agent (the service entry point)
    Run {
        /// Data folder (default: /var/lib/bmuster or C:\ProgramData\BMuster)
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// DEVELOPMENT ONLY: accept any TLS certificate from the server
        #[arg(long)]
        insecure_dev_tls: bool,
        /// Started by the Windows service manager
        #[cfg(windows)]
        #[arg(long, hide = true)]
        service: bool,
    },
    /// Show this machine's enrolment and service state
    Status {
        /// Data folder (default: /var/lib/bmuster or C:\ProgramData\BMuster)
        #[arg(long)]
        data_dir: Option<PathBuf>,
    },
    /// Stop and remove the service and the installed binary
    Uninstall {
        /// Also delete the data folder (identity and key)
        #[arg(long)]
        purge: bool,
    },
}

fn tls_mode(insecure_dev_tls: bool) -> TlsMode {
    if insecure_dev_tls {
        TlsMode::InsecureDev
    } else {
        TlsMode::Verify
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    #[cfg(windows)]
    if let Command::Run { service: true, .. } = cli.command {
        return run_windows_service();
    }

    if let Err(e) = logging::init_stderr() {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }
    match dispatch(cli.command) {
        Ok(code) => code,
        Err(e) => {
            log::error!("{e:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(windows)]
fn run_windows_service() -> ExitCode {
    let started = service_windows::log_path().and_then(|path| {
        logging::init_file(&path).map_err(anyhow::Error::msg)?;
        service_windows::run_as_service()
    });
    match started {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log::error!("{e:#}");
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}

fn dispatch(command: Command) -> Result<ExitCode> {
    match command {
        Command::Install(join) => {
            platform::install(&join.url, &join.code, join.name.as_deref())?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Enrol {
            join,
            data_dir,
            insecure_dev_tls,
        } => {
            identity::enrol(
                &paths::data_dir(data_dir)?,
                &identity::EnrolOptions {
                    url: &join.url,
                    code: &join.code,
                    name: join.name.as_deref(),
                    tls: tls_mode(insecure_dev_tls),
                },
            )?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Run {
            data_dir,
            insecure_dev_tls,
            ..
        } => {
            let options = worker::RunOptions {
                data_dir: paths::data_dir(data_dir)?,
                tls: tls_mode(insecure_dev_tls),
            };
            let (sender, signals) = mpsc::channel();
            match worker::run(&options, sender, signals)? {
                worker::Outcome::Stopped => Ok(ExitCode::SUCCESS),
                worker::Outcome::Revoked => Ok(ExitCode::from(EXIT_REVOKED)),
            }
        }
        Command::Status { data_dir } => status(&paths::data_dir(data_dir)?),
        Command::Uninstall { purge } => {
            platform::uninstall(purge)?;
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn status(data_dir: &std::path::Path) -> Result<ExitCode> {
    println!("Agent version: {}", env!("CARGO_PKG_VERSION"));
    println!("Data folder:   {}", data_dir.display());
    println!("Service:       {}", platform::service_state());
    if !identity::is_enrolled(data_dir) {
        println!("Enrolled:      no");
        return Ok(ExitCode::FAILURE);
    }
    let identity = identity::load(data_dir)?;
    println!("Enrolled:      yes");
    println!("Machine id:    {}", identity.machine_id);
    println!("Server:        {}", identity.server_url);
    println!("Check-in:      every {} s", identity.check_in_seconds);
    Ok(ExitCode::SUCCESS)
}

#[cfg(target_os = "linux")]
mod platform {
    pub use crate::service_linux::{install, service_state, uninstall};

    const _: () = assert!(crate::service_linux::REVOKED_EXIT_CODE == crate::EXIT_REVOKED);
}

#[cfg(windows)]
mod platform {
    pub use crate::service_windows::{install, service_state, uninstall};

    const _: () = assert!(crate::service_windows::REVOKED_EXIT_CODE == crate::EXIT_REVOKED as u32);
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use anyhow::{bail, Result};

    pub fn install(_url: &str, _code: &str, _name: Option<&str>) -> Result<()> {
        bail!("installing as a service is supported on Linux and Windows only")
    }

    pub fn uninstall(_purge: bool) -> Result<()> {
        bail!("uninstalling a service is supported on Linux and Windows only")
    }

    pub fn service_state() -> String {
        "not supported on this system".into()
    }
}
