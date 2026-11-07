//! `bmuster-server`: runs the bundled Node server and installs it as a
//! service. See `docs/specs/SPEC-SERVER-INSTALL.md`.

mod address;
mod bundle;
mod config;
mod layout;
mod node;
#[cfg(target_os = "linux")]
mod service_linux;
#[cfg(windows)]
mod service_windows;

use anyhow::{bail, Context as _, Result};
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
    },
    /// Stop and remove the service and the program folder (data is kept)
    Uninstall {
        #[command(flatten)]
        folders: Folders,
        /// Also delete the data folder (database, settings, secrets key)
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
            layout::own_dir()
                .and_then(|program| {
                    Ok(Layout {
                        program,
                        data: data_dir_or_default(data_dir.clone())?,
                    })
                })
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
        Command::Run { data_dir, .. } => run(&Layout {
            program: layout::own_dir()?,
            data: data_dir_or_default(data_dir)?,
        }),
        Command::Install {
            folders,
            port,
            no_service,
        } => {
            install(
                &layout::resolve(folders.prefix, folders.data_dir)?,
                port,
                no_service,
            )?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Uninstall { folders, purge } => {
            uninstall(&layout::resolve(folders.prefix, folders.data_dir)?, purge)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Status { folders } => {
            status(&layout::resolve(folders.prefix, folders.data_dir)?);
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// Node in the foreground: replaced in place on Unix (so systemd's signals
/// reach Node), waited for elsewhere.
fn run(layout: &Layout) -> Result<ExitCode> {
    if !layout.env_file().exists() {
        bail!(
            "there are no settings at {}; run `bmuster-server install` first",
            layout.env_file().display()
        );
    }
    let mut command = node::command(layout);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        let error = command.exec();
        Err(error).with_context(|| format!("could not start {}", layout.node().display()))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .with_context(|| format!("could not start {}", layout.node().display()))?;
        Ok(match status.code() {
            Some(0) => ExitCode::SUCCESS,
            Some(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
            None => ExitCode::FAILURE,
        })
    }
}

fn install(layout: &Layout, port: Option<u16>, no_service: bool) -> Result<()> {
    if !no_service {
        platform::require_admin()?;
    }
    let source = layout::own_dir()?;
    layout::check_bundle(&source)?;
    if !no_service && platform::stop_service()? {
        println!("Stopped the running server for the upgrade.");
    }
    bundle::replace_dir(&source, &layout.program)?;
    println!(
        "Installed BMuster Server {} in {}.",
        layout::bundle_version(&layout.program),
        layout.program.display()
    );

    std::fs::create_dir_all(&layout.data)
        .with_context(|| format!("could not create {}", layout.data.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&layout.data, std::fs::Permissions::from_mode(0o700))?;
    }
    if config::write_if_missing(&layout.env_file(), port.unwrap_or(config::DEFAULT_PORT))? {
        println!("Wrote new settings to {}.", layout.env_file().display());
    } else {
        println!("Kept the settings and data in {}.", layout.data.display());
        let kept = config::read_listen(&layout.env_file())?.port;
        if port.is_some_and(|wanted| wanted != kept) {
            println!(
                "Note: the server keeps port {kept}; change PORT in {} to move it.",
                layout.env_file().display()
            );
        }
    }

    if no_service {
        println!(
            "No service was installed. Start the server with:\n  \"{}\" run --data-dir \"{}\"",
            layout.launcher().display(),
            layout.data.display()
        );
    } else {
        platform::install_service(layout)?;
    }
    let listen = config::read_listen(&layout.env_file())?;
    println!("Address: {}", address::best_url(listen));
    Ok(())
}

fn uninstall(layout: &Layout, purge: bool) -> Result<()> {
    if platform::service_installed() {
        platform::require_admin()?;
        platform::remove_service()?;
    }
    if layout.program.exists() {
        layout::check_bundle(&layout.program)?;
        platform::remove_program(layout)?;
        println!("Removed {}.", layout.program.display());
    }
    if !layout.data.exists() {
        return Ok(());
    }
    if !purge {
        println!(
            "Kept {} (database, settings and secrets key); add --purge to remove it.",
            layout.data.display()
        );
        return Ok(());
    }
    if !layout.env_file().exists() && !layout.database().exists() {
        bail!(
            "{} has no server.env or bmuster.db, so it was left alone",
            layout.data.display()
        );
    }
    std::fs::remove_dir_all(&layout.data)
        .with_context(|| format!("could not remove {}", layout.data.display()))?;
    println!(
        "Removed {} (database, settings and secrets key).",
        layout.data.display()
    );
    platform::remove_user()
}

fn status(layout: &Layout) {
    println!(
        "Server version: {}",
        layout::bundle_version(&layout.program)
    );
    println!("Launcher:       {}", env!("CARGO_PKG_VERSION"));
    println!("Program folder: {}", layout.program.display());
    println!("Data folder:    {}", layout.data.display());
    println!("Service:        {}", platform::service_state());
    match config::read_listen(&layout.env_file()) {
        Ok(listen) => println!("Address:        {}", address::best_url(listen)),
        Err(e) => println!("Address:        unknown ({e:#})"),
    }
    println!("Log:            {}", platform::log_hint(layout));
}

#[cfg(target_os = "linux")]
mod platform {
    pub use crate::service_linux::{
        install_service, log_hint, remove_program, remove_service, remove_user, require_admin,
        service_installed, service_state, stop_service,
    };
}

#[cfg(windows)]
mod platform {
    pub use crate::service_windows::{
        install_service, log_hint, remove_program, remove_service, remove_user, require_admin,
        service_installed, service_state, stop_service,
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

    pub fn stop_service() -> Result<bool> {
        Ok(false)
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
