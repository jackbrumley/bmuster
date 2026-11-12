//! `bmuster-agent`: enrols a machine with a BMuster server, checks in, and
//! keeps a live socket open. See `docs/specs/SPEC-ENROLMENT.md`.

mod checks;
mod client;
#[cfg(target_os = "linux")]
mod console_helper;
mod diagnostics;
mod display_report;
mod exec;
mod files;
mod gpus;
mod identity;
mod inventory;
mod launcher;
mod local_page;
mod log_repeats;
mod log_spool;
mod logging;
#[cfg(target_os = "linux")]
mod move_to_opt;
mod paths;
mod power;
mod relocate;
mod removal;
mod rescue;
#[cfg(target_os = "linux")]
mod service_linux;
#[cfg(windows)]
mod service_windows;
mod sessions;
mod socket;
mod status;
mod storage;
mod timeline;
mod tls;
mod totp;
mod tray;
mod trust;
mod updates;
#[cfg(target_os = "linux")]
mod wayland;
mod worker;

use anyhow::{bail, Context as _, Result};
use bmuster_protocol::{CertificatePin, ServerTrust};
use clap::{Args, Parser, Subcommand};
use client::TlsMode;
use exec::placement::SessionMode;
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
#[command(name = "bmuster-agent", version = updates::VERSION, about = "BMuster Agent")]
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
    /// The portal helper a Wayland desktop session starts as the user's unit
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    WaylandHelper {
        /// The agent's connect-back socket for this unit
        socket: PathBuf,
    },
    /// The KMS screen reader a desktop session starts as a root unit
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    ConsoleHelper {
        /// The agent's connect-back socket for this unit
        socket: PathBuf,
    },
    /// A terminal session's unit program: makes the pty in the unit and
    /// runs the shell on it for the agent (not for use by hand)
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    PtyHost {
        /// The agent's connect-back socket for this unit
        socket: PathBuf,
        /// The shell and its arguments
        #[arg(last = true, required = true, value_parser = clap::value_parser!(std::ffi::OsString))]
        command: Vec<std::ffi::OsString>,
    },
    /// A command or files session's unit program: runs the program with
    /// pipes and relays them for the agent (not for use by hand)
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    StdioHost {
        /// The agent's connect-back socket for this unit
        socket: PathBuf,
        /// The program and its arguments
        #[arg(last = true, required = true, value_parser = clap::value_parser!(std::ffi::OsString))]
        command: Vec<std::ffi::OsString>,
    },
    /// Print what the kernel scans out to each display and save one PNG per
    /// display (run as root; nothing is sent anywhere)
    #[cfg(target_os = "linux")]
    KmsProbe {
        /// Where to save, like /tmp/kms.png (becomes /tmp/kms-<display>.png)
        #[arg(long)]
        png: PathBuf,
    },
    /// Show the user-session tray; --open opens local management without a tray host
    Tray {
        #[arg(long)]
        open: bool,
    },
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
        /// Where terminal, command and files sessions run: in this process,
        /// or (Linux, installed) as transient systemd services outside the
        /// service's sandbox. The installed unit sets BMUSTER_SESSIONS=systemd.
        #[arg(
            long,
            value_enum,
            env = "BMUSTER_SESSIONS",
            default_value = "in-process"
        )]
        sessions: SessionMode,
    },
    /// Serve one files session over stdin and stdout (run by the agent in a
    /// transient systemd service, under stdio-host; not for use by hand)
    #[cfg(target_os = "linux")]
    #[command(hide = true)]
    FilesHelper {
        /// Data folder, where the storage scans are (SPEC-STORAGE 5)
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Scan every local drive once, slowly, at the lowest priority (started
    /// by the agent; SPEC-STORAGE 3; not for use by hand)
    #[command(hide = true)]
    StorageScan {
        /// Data folder; the scans are kept in its storage folder
        #[arg(long)]
        data_dir: PathBuf,
        /// Someone asked for this pass (Rescan now): less pausing
        #[arg(long)]
        asked: bool,
    },
    /// Run the clean-up a person asked for (started by the agent;
    /// SPEC-STORAGE 11; not for use by hand)
    #[command(hide = true)]
    StorageClean {
        /// Data folder; the request and its progress are in its storage folder
        #[arg(long)]
        data_dir: PathBuf,
    },
    /// Run desktop sessions in this console session for the service (started
    /// by the Windows service as SYSTEM; not for use by hand)
    #[cfg(windows)]
    #[command(hide = true)]
    DesktopHelper {
        /// The service's pipe name (without -in or -out)
        #[arg(long, required_unless_present = "check")]
        pipe: Option<String>,
        /// The service's process id, checked against the pipe's server
        #[arg(long, required_unless_present = "check")]
        service_pid: Option<u32>,
        /// Run the helper's fixed self-checks, write their results to this
        /// file and exit (SPEC-DIAGNOSTICS 1)
        #[arg(long, value_name = "FILE", conflicts_with_all = ["pipe", "service_pid"])]
        check: Option<PathBuf>,
        /// Data folder (identity, key and server key)
        #[arg(long)]
        data_dir: PathBuf,
        /// DEVELOPMENT ONLY: accept any TLS certificate from the server
        #[arg(long)]
        insecure_dev_tls: bool,
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
    /// Put the previous version back after the service failed to start
    /// (run by the service manager from the rescue copy; needs root or
    /// Administrator)
    Rescue,
    /// Make the running version the rescue copy (run by the agent itself
    /// after a day of health; not for use by hand)
    #[command(hide = true)]
    RefreshRescue,
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
    // So does the desktop helper, to its own file beside it.
    #[cfg(windows)]
    let logged = match &cli.command {
        Command::Run { launched: true, .. } => service_windows::log_path()
            .map_err(|e| format!("{e:#}"))
            .and_then(|path| logging::init_file(&path)),
        Command::DesktopHelper { data_dir, .. } => {
            logging::init_file(&data_dir.join("desktop-helper.log"))
        }
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
        #[cfg(target_os = "linux")]
        Command::WaylandHelper { socket } => {
            wayland::helper::run(&socket)?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(target_os = "linux")]
        Command::ConsoleHelper { socket } => {
            console_helper::run(&socket)?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(target_os = "linux")]
        Command::PtyHost { socket, command } => {
            exec::pty_host::run(&socket, &command)?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(target_os = "linux")]
        Command::StdioHost { socket, command } => {
            exec::stdio_host::run(&socket, &command)?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(target_os = "linux")]
        Command::KmsProbe { png } => {
            console_helper::probe(&png)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Tray { open } => {
            tray::run(open)?;
            Ok(ExitCode::SUCCESS)
        }
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
            sessions,
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
                sessions,
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
            platform::require_admin()?;
            // Purged, the machine leaves its server for good: say so first
            // (SPEC-LOCAL-PAGE-TRANSPARENCY). Kept, the identity may be used
            // again by a reinstall, so the server is not told.
            #[cfg(any(target_os = "linux", windows))]
            if purge {
                let report =
                    removal::tell_server(&paths::default_data_dir()?, removal::REPORT_LIMIT);
                log::info!("{}", removal::describe(&report));
            }
            platform::uninstall(purge)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Rescue => {
            rescue::run()?;
            Ok(ExitCode::SUCCESS)
        }
        Command::RefreshRescue => {
            platform::refresh_service()?;
            Ok(ExitCode::SUCCESS)
        }
        Command::StorageScan { data_dir, asked } => {
            let speed = if asked {
                storage::pace::Speed::Asked
            } else {
                storage::pace::Speed::Background
            };
            storage::scan::run(&data_dir, speed)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::StorageClean { data_dir } => {
            storage::cleanup::run(&data_dir)?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(target_os = "linux")]
        Command::FilesHelper { data_dir } => {
            sessions::files_helper::serve(std::io::stdin(), std::io::stdout(), data_dir)?;
            Ok(ExitCode::SUCCESS)
        }
        #[cfg(windows)]
        Command::DesktopHelper {
            pipe,
            service_pid,
            check,
            data_dir,
            insecure_dev_tls,
        } => {
            // A panic lands in desktop-helper.log, which the service ships.
            logging::install_logged_panic_hook();
            match (check, pipe, service_pid) {
                (Some(out), _, _) => checks::windows::helper_checks(&out)?,
                (None, Some(pipe), Some(service_pid)) => sessions::windows_desktop::helper::run(
                    &sessions::windows_desktop::helper::Args {
                        pipe,
                        service_pid,
                        data_dir,
                        insecure_dev_tls,
                    },
                )?,
                _ => bail!("desktop-helper needs --pipe and --service-pid, or --check"),
            }
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
        finish_rescue, install, refresh_rescue_copy, refresh_service, require_admin,
        schedule_uninstall, service_state, start_service, stop_service, uninstall,
    };

    const _: () = assert!(crate::service_linux::REVOKED_EXIT_CODE == crate::EXIT_REVOKED);
}

#[cfg(windows)]
mod platform {
    pub use crate::service_windows::{
        finish_rescue, install, refresh_rescue_copy, refresh_service, require_admin,
        schedule_uninstall, service_state, start_service, stop_service, uninstall,
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

    pub fn finish_rescue() -> Result<()> {
        Ok(())
    }

    pub fn refresh_rescue_copy() -> Result<()> {
        Ok(())
    }

    pub fn refresh_service() -> Result<()> {
        bail!("the rescue copy is supported on Linux and Windows only")
    }
}
