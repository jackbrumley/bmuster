//! `bmuster-agent`: enrols a machine with a BMuster server, checks in, and
//! keeps a live socket open. See `docs/specs/SPEC-ENROLMENT.md`.

mod client;
mod exec;
mod files;
mod gpus;
mod identity;
mod inventory;
mod launcher;
mod local_page;
mod logging;
mod paths;
mod relocate;
#[cfg(target_os = "linux")]
mod service_linux;
#[cfg(windows)]
mod service_windows;
mod sessions;
mod socket;
mod status;
mod tls;
mod totp;
mod trust;
mod updates;
mod worker;

use anyhow::{bail, Context as _, Result};
use bmuster_protocol::{CertificatePin, ServerTrust};
use clap::{Args, Parser, Subcommand};
use client::TlsMode;
use status::RunMode;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

/// Exit code when the server has removed this machine (distinct from a crash).
const EXIT_REVOKED: u8 = 3;
/// Exit code asking the service manager to start the agent again (the local
/// page's Restart, or after moving servers).
const EXIT_RESTART: u8 = 4;
/// Exit code telling the launcher a checked build waits in `versions/incoming`.
const EXIT_UPDATE: u8 = launcher::EXIT_UPDATE;

#[derive(Parser)]
#[command(name = "bmuster-agent", version = updates::VERSION, about = "BMuster agent")]
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
    /// Local network mode: trust only the server certificate with this key,
    /// like sha256:<base64> (shown on the console's Add machine page)
    #[arg(long, value_name = "PIN")]
    pin_cert: Option<CertificatePin>,
}

impl Join {
    fn trust(&self) -> ServerTrust {
        match self.pin_cert {
            Some(pin) => ServerTrust::Pin { pin },
            None => ServerTrust::Public,
        }
    }
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
    /// Run the launcher, which runs the agent and keeps it up to date (the
    /// service entry point)
    Launch {
        /// Data folder (default: /var/lib/bmuster or C:\ProgramData\BMuster)
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// DEVELOPMENT ONLY: accept any TLS certificate from the server
        #[arg(long)]
        insecure_dev_tls: bool,
        /// Serve the local page on this port on localhost (tests and development)
        #[arg(long, hide = true, value_name = "PORT")]
        local_page_port: Option<u16>,
        /// Started by the Windows service manager
        #[cfg(windows)]
        #[arg(long, hide = true)]
        service: bool,
    },
    /// Run the agent itself, without updates (the launcher runs it with --launched)
    Run {
        /// Data folder (default: /var/lib/bmuster or C:\ProgramData\BMuster)
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// DEVELOPMENT ONLY: accept any TLS certificate from the server
        #[arg(long)]
        insecure_dev_tls: bool,
        /// Serve the local page on this port on localhost (tests and development)
        #[arg(long, hide = true, value_name = "PORT")]
        local_page_port: Option<u16>,
        /// Started by the launcher, which switches versions and restarts it
        #[arg(long, hide = true)]
        launched: bool,
    },
    /// Move this machine to another BMuster server: enrol there first, then
    /// leave this one (needs root or Administrator when installed)
    Rejoin {
        #[command(flatten)]
        join: Join,
        /// Data folder (default: /var/lib/bmuster or C:\ProgramData\BMuster)
        #[arg(long)]
        data_dir: Option<PathBuf>,
        /// DEVELOPMENT ONLY: accept any TLS certificate from both servers
        #[arg(long)]
        insecure_dev_tls: bool,
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

fn enrol_tls(join: &Join, insecure_dev_tls: bool) -> Result<TlsMode> {
    match (insecure_dev_tls, join.pin_cert) {
        (false, _) => Ok(TlsMode::Checked(join.trust())),
        (true, None) => Ok(TlsMode::InsecureDev),
        (true, Some(_)) => bail!("use either --pin-cert or --insecure-dev-tls, not both"),
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    #[cfg(windows)]
    if let Command::Launch { service: true, .. } = cli.command {
        return run_windows_service();
    }

    // A worker under the Windows service has no console: it logs to the file.
    #[cfg(windows)]
    let logged = match cli.command {
        Command::Run { launched: true, .. } => service_windows::log_path()
            .map_err(|e| format!("{e:#}"))
            .and_then(|path| logging::init_file(&path)),
        _ => logging::init_stderr(),
    };
    #[cfg(not(windows))]
    let logged = logging::init_stderr();
    if let Err(e) = logged {
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
            platform::install(&join.url, &join.code, join.name.as_deref(), join.trust())?;
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
                    tls: enrol_tls(&join, insecure_dev_tls)?,
                },
            )?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Launch {
            data_dir,
            insecure_dev_tls,
            local_page_port,
            ..
        } => {
            let mut worker_args = Vec::new();
            if insecure_dev_tls {
                worker_args.push("--insecure-dev-tls".into());
            }
            if let Some(port) = local_page_port {
                worker_args.push("--local-page-port".into());
                worker_args.push(port.to_string().into());
            }
            let launcher = launcher::Launcher::new(paths::data_dir(data_dir)?, worker_args)?;
            match launcher.run(&AtomicBool::new(false))? {
                launcher::Ended::Stopped => Ok(ExitCode::SUCCESS),
                launcher::Ended::Revoked => Ok(ExitCode::from(EXIT_REVOKED)),
            }
        }
        Command::Run {
            data_dir,
            insecure_dev_tls,
            local_page_port,
            launched,
        } => {
            // Under the launcher the agent restarts like a service: by exiting.
            let mode = if launched {
                RunMode::Service
            } else {
                run_mode()
            };
            let options = worker::RunOptions {
                data_dir: paths::data_dir(data_dir)?,
                insecure_dev_tls,
                mode,
                local_page_port,
                launched,
            };
            let (sender, signals) = mpsc::channel();
            match worker::run(&options, sender, signals)? {
                worker::Outcome::Stopped => Ok(ExitCode::SUCCESS),
                worker::Outcome::Revoked => Ok(ExitCode::from(EXIT_REVOKED)),
                worker::Outcome::Restart => match mode {
                    RunMode::Service => Ok(ExitCode::from(EXIT_RESTART)),
                    RunMode::Foreground => restart_in_place(),
                },
                worker::Outcome::Update => Ok(ExitCode::from(EXIT_UPDATE)),
            }
        }
        Command::Rejoin {
            join,
            data_dir,
            insecure_dev_tls,
        } => rejoin(&join, data_dir, insecure_dev_tls),
        Command::Status { data_dir } => status(&paths::data_dir(data_dir)?),
        Command::Uninstall { purge } => {
            platform::uninstall(purge)?;
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// Started by systemd (which sets `INVOCATION_ID` for every unit), or by hand.
/// The Windows service enters through `run --service` instead.
fn run_mode() -> RunMode {
    if cfg!(target_os = "linux")
        && std::env::var_os("INVOCATION_ID").is_some_and(|id| !id.is_empty())
    {
        RunMode::Service
    } else {
        RunMode::Foreground
    }
}

/// A copy started by hand restarts itself with the same arguments: in place
/// on Unix (same process id and terminal), as a new process on Windows.
fn restart_in_place() -> Result<ExitCode> {
    let program = std::env::current_exe().context("could not find this program's path")?;
    let arguments: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    log::info!("Starting again: {} {:?}", program.display(), arguments);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        let error = std::process::Command::new(&program).args(&arguments).exec();
        Err(error).context("could not restart the agent")
    }
    #[cfg(not(unix))]
    {
        std::process::Command::new(&program)
            .args(&arguments)
            .spawn()
            .context("could not restart the agent")?;
        Ok(ExitCode::SUCCESS)
    }
}

/// `bmuster-agent rejoin`: the local page's Move, from the command line. An
/// installed agent's service is stopped for the move and started again after
/// it, whether the move worked or not.
fn rejoin(join: &Join, data_dir: Option<PathBuf>, insecure_dev_tls: bool) -> Result<ExitCode> {
    let installed = data_dir.is_none();
    let dir = paths::data_dir(data_dir)?;
    if installed {
        platform::require_admin()?;
    }
    identity::finish_pending_move(&dir)?;
    let session = worker::open_session(&dir, insecure_dev_tls)?;
    let tls = match (join.pin_cert, insecure_dev_tls) {
        (Some(pin), _) => TlsMode::Checked(ServerTrust::Pin { pin }),
        (None, true) => TlsMode::InsecureDev,
        (None, false) => TlsMode::Checked(ServerTrust::Public),
    };
    let was_running = installed && platform::stop_service()?;
    let moved = relocate::move_to(
        &dir,
        &relocate::MoveTarget {
            url: &join.url,
            code: &join.code,
            name: join.name.as_deref(),
            tls,
        },
        &session,
        &|| {
            // Local page events still waiting go to the old server before it is left.
            if let Err(e) = local_page::journal::Journal::open(&dir).send(&session) {
                log::warn!("Could not send the local page's waiting events: {e:#}");
            }
        },
    );
    if was_running {
        platform::start_service()?;
    }
    let moved = moved?;
    println!(
        "Moved: this machine joined {} as machine {}.",
        moved.server_url, moved.machine_id
    );
    match moved.old_server {
        relocate::OldServer::Told => {
            println!("The old server was told and now refuses the old identity.")
        }
        relocate::OldServer::NotTold(reason) => println!(
            "The old server could not be told ({reason}); remove the machine there by hand."
        ),
    }
    if !installed {
        println!(
            "Restart any agent running from {} to use the new identity.",
            dir.display()
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn status(data_dir: &Path) -> Result<ExitCode> {
    println!("Agent version: {}", env!("BMUSTER_VERSION"));
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
    println!(
        "Certificate:   {}",
        trust::describe(&identity.server_trust())
    );
    if let Some(next) = identity.next_pin {
        println!("Announced:     {}", trust::describe(&next));
    }
    println!("Check-in:      every {} s", identity.check_in_seconds);
    for (label, value) in launcher::describe(data_dir) {
        println!("{label:<14} {value}");
    }
    Ok(ExitCode::SUCCESS)
}

#[cfg(target_os = "linux")]
mod platform {
    pub use crate::service_linux::{
        install, require_admin, schedule_uninstall, service_state, start_service, stop_service,
        uninstall,
    };

    const _: () = assert!(crate::service_linux::REVOKED_EXIT_CODE == crate::EXIT_REVOKED);
}

#[cfg(windows)]
mod platform {
    pub use crate::service_windows::{
        install, require_admin, schedule_uninstall, service_state, start_service, stop_service,
        uninstall,
    };

    const _: () = assert!(crate::service_windows::REVOKED_EXIT_CODE == crate::EXIT_REVOKED as u32);
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use anyhow::{bail, Result};
    use bmuster_protocol::ServerTrust;

    pub fn install(
        _url: &str,
        _code: &str,
        _name: Option<&str>,
        _trust: ServerTrust,
    ) -> Result<()> {
        bail!("installing as a service is supported on Linux and Windows only")
    }

    pub fn uninstall(_purge: bool) -> Result<()> {
        bail!("uninstalling a service is supported on Linux and Windows only")
    }

    pub fn service_state() -> String {
        "not supported on this system".into()
    }

    pub fn require_admin() -> Result<()> {
        Ok(())
    }

    pub fn stop_service() -> Result<bool> {
        Ok(false)
    }

    pub fn start_service() -> Result<()> {
        Ok(())
    }

    pub fn schedule_uninstall() -> Result<()> {
        bail!("uninstalling a service is supported on Linux and Windows only")
    }
}
