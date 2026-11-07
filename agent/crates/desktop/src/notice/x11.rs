//! The notice bar on X11: an override-redirect window at the top centre of
//! the screen, drawn with the server's built-in `fixed` font, on its own
//! thread and its own connection. X11 cannot keep a window out of a screen
//! capture, so viewers see the bar too (SPEC-DESKTOP open question 3).

use super::{bar_text, BarCommand, BAR_TITLE, DISCONNECT_LABEL};
use crate::capture::x11_session::{connect, X11Target};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ChangeGCAux, ConfigureWindowAux, ConnectionExt as _, CreateGCAux, CreateWindowAux,
    EventMask, Font, Gcontext, PropMode, Rectangle, StackMode, Window, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// How often the bar checks for commands and raises itself.
const POLL: Duration = Duration::from_millis(50);
const RAISE_EVERY: Duration = Duration::from_secs(1);
const PADDING: i16 = 10;
const BUTTON_GAP: i16 = 16;
const BACKGROUND: u32 = 0x1F_2937;
const TEXT: u32 = 0xF9_FAFB;
const BUTTON: u32 = 0xB9_1C1C;

/// Starts the bar showing `names`; commands on the returned channel change
/// it or close it.
pub fn start(target: X11Target, names: Vec<String>) -> Result<Sender<BarCommand>, String> {
    let (commands, inbox) = mpsc::channel();
    let (opened, ready) = mpsc::channel();
    std::thread::Builder::new()
        .name("desktop-notice".into())
        .spawn(move || match Bar::open(&target, &names) {
            Ok(mut bar) => {
                let _ = opened.send(Ok(()));
                if let Err(error) = bar.run(&inbox) {
                    log::error!("The notice bar stopped: {error}");
                }
            }
            Err(error) => {
                let _ = opened.send(Err(error));
            }
        })
        .map_err(|e| format!("cannot start the notice thread: {e}"))?;
    match ready.recv() {
        Ok(Ok(())) => Ok(commands),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("the notice thread stopped before the bar was up".into()),
    }
}

fn failed<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> String {
    move |error| format!("{what}: {error}")
}

/// Latin-1 bytes for the core font; anything else shows as `?`.
fn latin1(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect()
}

struct Layout {
    width: u16,
    height: u16,
    text_y: i16,
    button: Rectangle,
}

struct Bar {
    connection: RustConnection,
    window: Window,
    gc: Gcontext,
    font: Font,
    screen_width: u16,
    char_width: i16,
    ascent: i16,
    descent: i16,
    text: Vec<u8>,
    layout: Layout,
}

impl Bar {
    fn open(target: &X11Target, names: &[String]) -> Result<Bar, String> {
        let (connection, screen) = connect(target)?;
        let root = connection.setup().roots[screen].root;
        let screen_width = connection.setup().roots[screen].width_in_pixels;
        let font = connection.generate_id().map_err(failed("font id"))?;
        connection
            .open_font(font, b"fixed")
            .map_err(failed("open font"))?
            .check()
            .map_err(failed("the X server has no 'fixed' font"))?;
        let info = connection
            .query_font(font)
            .map_err(failed("query font"))?
            .reply()
            .map_err(failed("query font"))?;
        let window = connection.generate_id().map_err(failed("window id"))?;
        let gc = connection.generate_id().map_err(failed("gc id"))?;
        let mut bar = Bar {
            window,
            gc,
            font,
            screen_width,
            char_width: info.max_bounds.character_width.max(1),
            ascent: info.font_ascent,
            descent: info.font_descent,
            text: Vec::new(),
            layout: Layout {
                width: 1,
                height: 1,
                text_y: 0,
                button: Rectangle {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
            },
            connection,
        };
        bar.set_names(names);
        let layout = &bar.layout;
        bar.connection
            .create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                window,
                root,
                bar.x(),
                0,
                layout.width,
                layout.height,
                0,
                WindowClass::INPUT_OUTPUT,
                x11rb::COPY_FROM_PARENT,
                &CreateWindowAux::new()
                    .override_redirect(1)
                    .background_pixel(BACKGROUND)
                    .event_mask(
                        EventMask::EXPOSURE
                            | EventMask::BUTTON_PRESS
                            | EventMask::VISIBILITY_CHANGE,
                    ),
            )
            .map_err(failed("create window"))?;
        bar.connection
            .change_property8(
                PropMode::REPLACE,
                window,
                AtomEnum::WM_NAME,
                AtomEnum::STRING,
                BAR_TITLE.as_bytes(),
            )
            .map_err(failed("name window"))?;
        bar.connection
            .create_gc(gc, window, &CreateGCAux::new().font(font))
            .map_err(failed("create gc"))?;
        bar.connection
            .map_window(window)
            .map_err(failed("map window"))?;
        bar.raise()?;
        bar.connection.flush().map_err(failed("flush"))?;
        log::info!("Notice bar shown: {}", String::from_utf8_lossy(&bar.text));
        Ok(bar)
    }

    fn x(&self) -> i16 {
        ((i32::from(self.screen_width) - i32::from(self.layout.width)) / 2).max(0) as i16
    }

    fn set_names(&mut self, names: &[String]) {
        self.text = latin1(&format!("{} \u{b7}", bar_text(names)));
        let line = self.ascent + self.descent;
        let height = line + 12;
        let text_width = self.text.len() as i16 * self.char_width;
        let label_width = DISCONNECT_LABEL.len() as i16 * self.char_width;
        let button = Rectangle {
            x: PADDING + text_width + BUTTON_GAP / 2,
            y: 3,
            width: (label_width + PADDING) as u16,
            height: (height - 6) as u16,
        };
        let width = button.x + button.width as i16 + PADDING;
        self.layout = Layout {
            width: width.max(1) as u16,
            height: height as u16,
            text_y: (height + self.ascent - self.descent) / 2,
            button,
        };
    }

    fn raise(&self) -> Result<(), String> {
        self.connection
            .configure_window(
                self.window,
                &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE),
            )
            .map_err(failed("raise"))?;
        Ok(())
    }

    fn draw(&self) -> Result<(), String> {
        let c = &self.connection;
        let layout = &self.layout;
        c.change_gc(self.gc, &ChangeGCAux::new().foreground(BACKGROUND))
            .map_err(failed("draw"))?;
        c.poly_fill_rectangle(
            self.window,
            self.gc,
            &[Rectangle {
                x: 0,
                y: 0,
                width: layout.width,
                height: layout.height,
            }],
        )
        .map_err(failed("draw"))?;
        c.change_gc(
            self.gc,
            &ChangeGCAux::new().foreground(TEXT).background(BACKGROUND),
        )
        .map_err(failed("draw"))?;
        c.image_text8(self.window, self.gc, PADDING, layout.text_y, &self.text)
            .map_err(failed("draw"))?;
        c.change_gc(self.gc, &ChangeGCAux::new().foreground(BUTTON))
            .map_err(failed("draw"))?;
        c.poly_fill_rectangle(self.window, self.gc, &[layout.button])
            .map_err(failed("draw"))?;
        c.change_gc(
            self.gc,
            &ChangeGCAux::new().foreground(TEXT).background(BUTTON),
        )
        .map_err(failed("draw"))?;
        c.image_text8(
            self.window,
            self.gc,
            layout.button.x + PADDING / 2,
            layout.text_y,
            DISCONNECT_LABEL.as_bytes(),
        )
        .map_err(failed("draw"))?;
        c.flush().map_err(failed("flush"))?;
        Ok(())
    }

    fn on_button(&self, x: i16, y: i16) -> bool {
        let b = self.layout.button;
        x >= b.x && x < b.x + b.width as i16 && y >= b.y && y < b.y + b.height as i16
    }

    fn run(&mut self, inbox: &Receiver<BarCommand>) -> Result<(), String> {
        let mut raised = Instant::now();
        loop {
            while let Some(event) = self
                .connection
                .poll_for_event()
                .map_err(failed("X connection lost"))?
            {
                match event {
                    Event::Expose(e) if e.count == 0 => self.draw()?,
                    Event::ButtonPress(e) if self.on_button(e.event_x, e.event_y) => {
                        super::disconnect_all();
                    }
                    Event::VisibilityNotify(_) => self.raise()?,
                    _ => {}
                }
            }
            match inbox.recv_timeout(POLL) {
                Ok(BarCommand::Names(names)) => {
                    self.set_names(&names);
                    self.connection
                        .configure_window(
                            self.window,
                            &ConfigureWindowAux::new()
                                .x(i32::from(self.x()))
                                .width(u32::from(self.layout.width))
                                .height(u32::from(self.layout.height)),
                        )
                        .map_err(failed("resize"))?;
                    self.draw()?;
                }
                Ok(BarCommand::Close) | Err(RecvTimeoutError::Disconnected) => {
                    let _ = self.connection.destroy_window(self.window);
                    let _ = self.connection.free_gc(self.gc);
                    let _ = self.connection.close_font(self.font);
                    let _ = self.connection.flush();
                    log::info!("Notice bar closed");
                    return Ok(());
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            if raised.elapsed() >= RAISE_EVERY {
                raised = Instant::now();
                self.raise()?;
                self.connection.flush().map_err(failed("flush"))?;
            }
        }
    }
}
