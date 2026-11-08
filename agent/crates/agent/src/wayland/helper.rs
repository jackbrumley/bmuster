//! User-session portal owner. No private agent files or network credentials.
use super::{
    png_stream,
    wire::{self, Command, Event, Packet},
};
use anyhow::{bail, Context as _, Result};
use ashpd::desktop::{
    remote_desktop::{DeviceType, KeyState, RemoteDesktop},
    screencast::{CursorMode, Screencast, SourceType},
    PersistMode,
};
use std::os::fd::AsRawFd as _;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};

type Output = Arc<Mutex<std::io::Stdout>>;
fn event(output: &Output, value: &Event) -> Result<()> {
    wire::json(
        &mut *output
            .lock()
            .map_err(|_| anyhow::anyhow!("Capture output lock failed"))?,
        value,
    )
}

struct Capture(Child);
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn capture(fd: std::os::fd::OwnedFd, node: u32, output: Output) -> Result<Capture> {
    use std::os::unix::process::CommandExt as _;
    let mut command = std::process::Command::new("/usr/bin/gst-launch-1.0");
    command.args([
        "-q",
        "pipewiresrc",
        "fd=3",
        &format!("path={node}"),
        "do-timestamp=true",
        "!",
        "queue",
        "max-size-buffers=1",
        "max-size-bytes=0",
        "max-size-time=0",
        "leaky=downstream",
        "!",
        "videorate",
        "drop-only=true",
        "!",
        "video/x-raw,framerate=15/1",
        "!",
        "videoconvert",
        "!",
        "video/x-raw,format=RGB",
        "!",
        "pngenc",
        "compression-level=0",
        "!",
        "fdsink",
        "fd=1",
        "sync=false",
    ]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let raw = fd.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(raw, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = Capture(command.spawn().context(
        "Wayland capture requires GStreamer tools, good plugins and the PipeWire plugin",
    )?);
    let mut stdout = child.0.stdout.take().context("Capture stdout missing")?;
    std::thread::Builder::new()
        .name("wayland pixels".into())
        .spawn(move || {
            let result = (|| -> Result<()> {
                loop {
                    let bytes = png_stream::read_png(&mut stdout)?;
                    wire::write(
                        &mut *output
                            .lock()
                            .map_err(|_| anyhow::anyhow!("Capture output lock failed"))?,
                        &Packet::Png(bytes),
                    )?;
                }
            })();
            if let Err(error) = result {
                let _ = event(
                    &output,
                    &Event::Failed {
                        message: format!("Wayland capture stopped: {error:#}"),
                    },
                );
            }
        })?;
    Ok(child)
}

pub fn run() -> Result<()> {
    if unsafe { libc::geteuid() } == 0 {
        bail!("The Wayland helper must run as the signed-in user");
    }
    set_wayland_display()?;
    let Packet::Json(config) = wire::read(std::io::stdin())? else {
        bail!("Missing helper configuration");
    };
    let Command::Configure {
        control,
        restore_token,
    } = serde_json::from_slice(&config)?
    else {
        bail!("Invalid helper configuration");
    };
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let (send, mut receive) = tokio::sync::mpsc::channel(32);
    std::thread::Builder::new()
        .name("wayland input".into())
        .spawn(move || {
            let mut stdin = std::io::stdin();
            loop {
                let command = match wire::read(&mut stdin) {
                    Ok(Packet::Json(bytes)) if bytes.len() <= 4096 => {
                        serde_json::from_slice::<Command>(&bytes)
                    }
                    _ => break,
                };
                match command {
                    Ok(command) => {
                        if send.blocking_send(command).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = send.blocking_send(Command::Stop);
        })?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()?;
    let result = runtime.block_on(async {
        let cast = Screencast::new().await?;
        if control {
            let remote = RemoteDesktop::new().await?;
            let session = remote.create_session().await?;
            remote.select_devices(&session, DeviceType::Keyboard | DeviceType::Pointer, restore_token.as_deref(), PersistMode::ExplicitlyRevoked).await?.response()?;
            cast.select_sources(&session, CursorMode::Embedded, SourceType::Monitor.into(), false, None, PersistMode::DoNot).await?.response()?;
            let start = async { remote.start(&session, None).await?.response() };
            let response = tokio::select! { result = tokio::time::timeout(std::time::Duration::from_secs(90), start) => result??, _ = receive.recv() => bail!("Approval cancelled") };
            if !response.devices().contains(DeviceType::Keyboard) || !response.devices().contains(DeviceType::Pointer) { bail!("The desktop did not grant keyboard and pointer access"); }
            event(&output, &Event::Token { token: response.restore_token().map(str::to_owned) })?;
            let stream = response.streams().and_then(|s| s.first()).context("The desktop did not grant a monitor")?;
            let node = stream.pipe_wire_node_id();
            let (x, y) = stream.position().unwrap_or((0, 0));
            let (width, height) = stream.size().context("The desktop portal did not report monitor geometry")?;
            if width <= 0 || height <= 0 || width > 32768 || height > 32768 {
                bail!("The desktop portal reported invalid monitor geometry");
            }
            let fd = cast.open_pipe_wire_remote(&session).await?;
            let _capture = capture(fd, node, Arc::clone(&output))?;
            event(&output, &Event::Ready {
                x,
                y,
                width,
                height,
            })?;
            while let Some(command) = receive.recv().await {
                let down = |down| if down { KeyState::Pressed } else { KeyState::Released };
                match command {
                    Command::Pointer { x, y } => remote.notify_pointer_motion_absolute(&session, node, f64::from(x), f64::from(y)).await?,
                    Command::Button { code, down: pressed } => remote.notify_pointer_button(&session, code, down(pressed)).await?,
                    Command::Scroll { dx, dy } => remote.notify_pointer_axis(&session, dx, dy, false).await?,
                    Command::Key { code, down: pressed } => remote.notify_keyboard_keycode(&session, code, down(pressed)).await?,
                    Command::Character { character } => { let code = if character as u32 <= 0xff { character as i32 } else { (character as u32 | 0x01000000) as i32 }; remote.notify_keyboard_keysym(&session, code, KeyState::Pressed).await?; remote.notify_keyboard_keysym(&session, code, KeyState::Released).await?; }
                    Command::Stop => break,
                    Command::Configure { .. } => bail!("Helper cannot be reconfigured"),
                }
            }
            session.close().await?;
        } else {
            let session = cast.create_session().await?;
            cast.select_sources(&session, CursorMode::Embedded, SourceType::Monitor.into(), false, restore_token.as_deref(), PersistMode::ExplicitlyRevoked).await?.response()?;
            let start = async { cast.start(&session, None).await?.response() };
            let response = tokio::select! { result = tokio::time::timeout(std::time::Duration::from_secs(90), start) => result??, _ = receive.recv() => bail!("Approval cancelled") };
            event(&output, &Event::Token { token: response.restore_token().map(str::to_owned) })?;
            let stream = response.streams().first().context("The desktop did not grant a monitor")?;
            let node = stream.pipe_wire_node_id();
            let (x, y) = stream.position().unwrap_or((0, 0));
            let (width, height) = stream.size().context("The desktop portal did not report monitor geometry")?;
            if width <= 0 || height <= 0 || width > 32768 || height > 32768 {
                bail!("The desktop portal reported invalid monitor geometry");
            }
            let _capture = capture(cast.open_pipe_wire_remote(&session).await?, node, Arc::clone(&output))?;
            event(&output, &Event::Ready {
                x,
                y,
                width,
                height,
            })?;
            if let Some(command) = receive.recv().await { if !matches!(command, Command::Stop) { bail!("Watch sessions cannot send input"); } }
            session.close().await?;
        }
        Ok::<(), anyhow::Error>(())
    });
    if let Err(error) = &result {
        let _ = event(
            &output,
            &Event::Failed {
                message: format!("Wayland permission or capture failed: {error:#}"),
            },
        );
    }
    result
}

fn set_wayland_display() -> Result<()> {
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Ok(());
    }
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .context("The signed-in user's runtime directory is unavailable")?;
    let display = find_wayland_display(std::path::Path::new(&runtime))?;
    std::env::set_var("WAYLAND_DISPLAY", display);
    Ok(())
}

fn find_wayland_display(runtime: &std::path::Path) -> Result<String> {
    use std::os::unix::fs::FileTypeExt as _;
    let mut sockets = std::fs::read_dir(runtime)?
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            if !name.starts_with("wayland-") || !entry.file_type().ok()?.is_socket() {
                return None;
            }
            Some(name.to_owned())
        })
        .collect::<Vec<_>>();
    sockets.sort();
    match sockets.as_slice() {
        [display] => Ok(display.clone()),
        [] => bail!("The signed-in user's Wayland socket was not found"),
        _ => bail!("Several Wayland sockets exist; the session display is ambiguous"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn display_name_must_match_one_user_socket() {
        let dir = tempfile::tempdir().unwrap();
        assert!(super::find_wayland_display(dir.path()).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::net::UnixListener;
            let _socket = UnixListener::bind(dir.path().join("wayland-0")).unwrap();
            assert_eq!(
                super::find_wayland_display(dir.path()).unwrap(),
                "wayland-0"
            );
        }
    }
}
