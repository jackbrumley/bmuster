//! The notice bar on Windows (SPEC-DESKTOP 8): a small topmost tool window
//! at the top centre of the primary display, "<names> is connected
//! (BMuster)" and a Disconnect button, on its own thread with its own
//! message loop. `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` keeps it
//! out of DXGI and GDI captures (Windows 10 2004 and later; older builds
//! show it in the stream). It folds to a pill and opens again when the
//! pointer is over it, as [`Fold`] says; the pointer is read on each timer
//! tick, so moving onto the Disconnect button (a child window) still counts
//! as over the bar.
//!
//! The helper process starts on the Default desktop and the bar's thread
//! never moves, so the bar shows on the user's desktop only: not on the
//! lock screen, the sign-in screen or a UAC prompt, which are the Winlogon
//! desktop. Written from the Win32 documentation.

use super::state::{pill_text, Fold, Size};
use super::{bar_text, disconnect_all, BarCommand, BAR_TITLE, DISCONNECT_LABEL};
use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use ::windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontIndirectW, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect,
    GetDC, GetTextExtentPoint32W, InvalidateRect, ReleaseDC, SelectObject, SetBkMode, SetTextColor,
    DT_LEFT, DT_SINGLELINE, DT_VCENTER, HDC, HFONT, HGDIOBJ, PAINTSTRUCT, TRANSPARENT,
};
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::UI::HiDpi::GetDpiForSystem;
use ::windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetSystemMetrics, GetWindowRect, PostQuitMessage, RegisterClassExW, SendMessageW, SetTimer,
    SetWindowDisplayAffinity, SetWindowPos, ShowWindow, SystemParametersInfoW, TranslateMessage,
    BS_PUSHBUTTON, HMENU, HWND_TOPMOST, MSG, NONCLIENTMETRICSW, SM_CXSCREEN,
    SPI_GETNONCLIENTMETRICS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNOACTIVATE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WINDOW_DISPLAY_AFFINITY, WINDOW_STYLE,
    WM_COMMAND, WM_DESTROY, WM_LBUTTONDOWN, WM_PAINT, WM_SETFONT, WM_TIMER, WNDCLASSEXW, WS_CHILD,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};
use std::cell::RefCell;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::time::Instant;

/// Windows 10 2004: the window is left out of every capture.
const WDA_EXCLUDEFROMCAPTURE: WINDOW_DISPLAY_AFFINITY = WINDOW_DISPLAY_AFFINITY(0x11);
const CLASS: &str = "BMusterNoticeBar";
const BUTTON_ID: usize = 1;
const TIMER_ID: usize = 1;
/// How often the bar reads its commands and the pointer, and stays on top.
const POLL_MS: u32 = 200;
/// Sizes at 96 dpi.
const PADDING: i32 = 10;
const BUTTON_WIDTH: i32 = 96;
const HEIGHT: i32 = 36;
const PILL_HEIGHT: i32 = 22;
const PILL_PADDING: i32 = 6;
const MARKER: i32 = 8;
/// 0x00BBGGRR: the X11 bar's colours.
const BACKGROUND: COLORREF = COLORREF(0x0037_291F);
const TEXT: COLORREF = COLORREF(0x00FB_FAF9);
const MARKER_COLOUR: COLORREF = COLORREF(0x001C_1CB9);

struct State {
    inbox: Receiver<BarCommand>,
    text: Vec<u16>,
    pill_text: Vec<u16>,
    font: HFONT,
    button: HWND,
    scale: f64,
    fold: Fold,
    /// The size the window has now.
    size: Size,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Starts the bar showing `names`; commands on the returned channel change
/// it or close it.
pub fn start(names: Vec<String>) -> Result<Sender<BarCommand>, String> {
    let (commands, inbox) = mpsc::channel();
    let (opened, ready) = mpsc::channel();
    std::thread::Builder::new()
        .name("desktop-notice".into())
        .spawn(move || {
            // SAFETY: the window and its resources belong to this thread,
            // which runs their message loop until the bar closes.
            match unsafe { open(&names, inbox) } {
                Ok(()) => {
                    let _ = opened.send(Ok(()));
                    unsafe { run() };
                }
                Err(error) => {
                    let _ = opened.send(Err(error));
                }
            }
        })
        .map_err(|e| format!("cannot start the notice thread: {e}"))?;
    match ready.recv() {
        Ok(Ok(())) => Ok(commands),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("the notice thread stopped before the bar was up".into()),
    }
}

fn scaled(value: i32, scale: f64) -> i32 {
    (f64::from(value) * scale).round() as i32
}

/// The system's message font, for the text and the button.
unsafe fn message_font() -> HFONT {
    let mut metrics = NONCLIENTMETRICSW {
        cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
        ..Default::default()
    };
    // SAFETY: `metrics` has cbSize set, as the call requires.
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETNONCLIENTMETRICS,
            metrics.cbSize,
            Some((&mut metrics as *mut NONCLIENTMETRICSW).cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        CreateFontIndirectW(&metrics.lfMessageFont)
    }
}

/// The width of `text` (NUL-terminated) in `font`.
unsafe fn text_width(text: &[u16], font: HFONT) -> i32 {
    // SAFETY: a screen DC, released before returning.
    unsafe {
        let dc = GetDC(None);
        let old = SelectObject(dc, HGDIOBJ(font.0));
        let mut size = SIZE::default();
        let shown = &text[..text.len().saturating_sub(1)];
        let _ = GetTextExtentPoint32W(dc, shown, &mut size);
        SelectObject(dc, old);
        ReleaseDC(None, dc);
        size.cx
    }
}

/// The window's width and height at its current size.
unsafe fn dimensions(state: &State) -> (i32, i32) {
    // SAFETY: measuring text on a screen DC.
    unsafe {
        match state.size {
            Size::Full => (
                text_width(&state.text, state.font)
                    + scaled(PADDING * 3 + BUTTON_WIDTH, state.scale),
                scaled(HEIGHT, state.scale),
            ),
            Size::Pill => (
                text_width(&state.pill_text, state.font)
                    + scaled(PILL_PADDING * 3 + MARKER, state.scale),
                scaled(PILL_HEIGHT, state.scale),
            ),
        }
    }
}

/// Puts the bar at the top centre: full size with its button on the
/// right, or the pill with the button hidden.
unsafe fn place(window: HWND, state: &State) {
    // SAFETY: our own windows.
    unsafe {
        let (width, height) = dimensions(state);
        let left = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
        let _ = SetWindowPos(
            window,
            Some(HWND_TOPMOST),
            left,
            0,
            width,
            height,
            SWP_NOACTIVATE,
        );
        match state.size {
            Size::Full => {
                let padding = scaled(PADDING / 2, state.scale);
                let _ = SetWindowPos(
                    state.button,
                    None,
                    width - scaled(BUTTON_WIDTH + PADDING, state.scale),
                    padding,
                    scaled(BUTTON_WIDTH, state.scale),
                    height - 2 * padding,
                    SWP_NOACTIVATE,
                );
                let _ = ShowWindow(state.button, SW_SHOWNOACTIVATE);
            }
            Size::Pill => {
                let _ = ShowWindow(state.button, SW_HIDE);
            }
        }
        let _ = InvalidateRect(Some(window), None, true);
    }
}

unsafe fn open(names: &[String], inbox: Receiver<BarCommand>) -> Result<(), String> {
    // SAFETY: plain Win32 window creation on this thread.
    unsafe {
        let instance = GetModuleHandleW(PCWSTR::null()).map_err(|e| e.to_string())?;
        let class = wide(CLASS);
        let registration = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            lpszClassName: PCWSTR(class.as_ptr()),
            ..Default::default()
        };
        // Fails harmlessly when an earlier bar registered it.
        RegisterClassExW(&registration);
        let title = wide(BAR_TITLE);
        let window = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            PCWSTR(class.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_POPUP,
            0,
            0,
            1,
            1,
            None,
            None,
            Some(instance.into()),
            None,
        )
        .map_err(|e| format!("CreateWindowEx (notice bar): {e}"))?;
        let label = wide(DISCONNECT_LABEL);
        let button_class = wide("BUTTON");
        let button = CreateWindowExW(
            Default::default(),
            PCWSTR(button_class.as_ptr()),
            PCWSTR(label.as_ptr()),
            WS_CHILD | WS_VISIBLE | WINDOW_STYLE(BS_PUSHBUTTON as u32),
            0,
            0,
            1,
            1,
            Some(window),
            Some(HMENU(BUTTON_ID as *mut _)),
            Some(instance.into()),
            None,
        )
        .map_err(|e| format!("CreateWindowEx (Disconnect): {e}"))?;
        let font = message_font();
        SendMessageW(
            button,
            WM_SETFONT,
            Some(WPARAM(font.0 as usize)),
            Some(LPARAM(1)),
        );
        if let Err(error) = SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE) {
            log::warn!(
                "The notice bar cannot be kept out of the capture ({error}); viewers will see it"
            );
        }
        let state = State {
            inbox,
            text: wide(&bar_text(names)),
            pill_text: wide(&pill_text(names.len())),
            font,
            button,
            scale: f64::from(GetDpiForSystem().max(96)) / 96.0,
            fold: Fold::new(names, Instant::now()),
            size: Size::Full,
        };
        place(window, &state);
        STATE.with(|cell| *cell.borrow_mut() = Some(state));
        SetTimer(Some(window), TIMER_ID, POLL_MS, None);
        let _ = SetWindowPos(
            window,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        );
        Ok(())
    }
}

unsafe fn run() {
    let mut message = MSG::default();
    // SAFETY: the thread's own message loop.
    unsafe {
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    STATE.with(|cell| {
        if let Some(state) = cell.borrow_mut().take() {
            // SAFETY: the font was made by `open` and nothing uses it now.
            unsafe {
                let _ = DeleteObject(HGDIOBJ(state.font.0));
            }
        }
    });
}

/// Whether the pointer is over the bar (its button included).
unsafe fn pointer_inside(window: HWND) -> bool {
    let mut point = POINT::default();
    let mut rect = RECT::default();
    // SAFETY: two out-parameters on this thread's own window. Either call
    // fails while the input desktop is another one: not over the bar.
    unsafe {
        if GetCursorPos(&mut point).is_err() || GetWindowRect(window, &mut rect).is_err() {
            return false;
        }
    }
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

/// Reads the commands that arrived and the pointer; false when the bar
/// should close.
unsafe fn read_commands(window: HWND) -> bool {
    STATE.with(|cell| {
        let mut borrowed = cell.borrow_mut();
        let Some(state) = borrowed.as_mut() else {
            return false;
        };
        let now = Instant::now();
        let mut changed = false;
        loop {
            match state.inbox.try_recv() {
                Ok(BarCommand::Names(names)) => {
                    state.fold.names(&names, now);
                    state.text = wide(&bar_text(&names));
                    state.pill_text = wide(&pill_text(names.len()));
                    changed = true;
                }
                // The board asks whether the bar is still up; it is.
                Ok(BarCommand::Check) => {}
                Ok(BarCommand::Close) | Err(TryRecvError::Disconnected) => return false,
                Err(TryRecvError::Empty) => break,
            }
        }
        // SAFETY: our own window.
        unsafe {
            state.fold.pointer(pointer_inside(window), now);
            let size = state.fold.size(now);
            if size != state.size {
                state.size = size;
                changed = true;
            }
            if changed {
                place(window, state);
            } else {
                // Stay above windows that came up since.
                let _ = SetWindowPos(
                    window,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE,
                );
            }
        }
        true
    })
}

/// A press on the pill opens it (touch screens have no hover); a press on
/// the full bar outside its button does nothing.
unsafe fn pressed(window: HWND) {
    STATE.with(|cell| {
        let mut borrowed = cell.borrow_mut();
        let Some(state) = borrowed.as_mut() else {
            return;
        };
        if state.size == Size::Pill {
            let now = Instant::now();
            state.fold.pressed(now);
            state.size = state.fold.size(now);
            // SAFETY: our own window.
            unsafe { place(window, state) };
        }
    });
}

/// Draws `text` (NUL-terminated) from `left`, centred in `height`.
unsafe fn draw_text(dc: HDC, state: &State, text: &[u16], left: i32, height: i32) {
    let mut shown = text.to_vec();
    shown.pop();
    let mut rect = RECT {
        left,
        top: 0,
        right: i32::MAX / 2,
        bottom: height,
    };
    // SAFETY: a DC from BeginPaint; the font is ours and put back after.
    unsafe {
        let old = SelectObject(dc, HGDIOBJ(state.font.0));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, TEXT);
        DrawTextW(
            dc,
            &mut shown,
            &mut rect,
            DT_LEFT | DT_SINGLELINE | DT_VCENTER,
        );
        SelectObject(dc, old);
    }
}

unsafe fn paint(window: HWND) {
    let mut paint = PAINTSTRUCT::default();
    // SAFETY: BeginPaint/EndPaint pair on our own window; the brushes are
    // deleted after use.
    unsafe {
        let dc = BeginPaint(window, &mut paint);
        let brush = CreateSolidBrush(BACKGROUND);
        FillRect(dc, &paint.rcPaint, brush);
        let _ = DeleteObject(HGDIOBJ(brush.0));
        STATE.with(|cell| {
            if let Some(state) = cell.borrow().as_ref() {
                match state.size {
                    Size::Full => {
                        let height = scaled(HEIGHT, state.scale);
                        draw_text(dc, state, &state.text, scaled(PADDING, state.scale), height);
                    }
                    Size::Pill => {
                        let height = scaled(PILL_HEIGHT, state.scale);
                        let side = scaled(MARKER, state.scale);
                        let left = scaled(PILL_PADDING, state.scale);
                        let top = (height - side) / 2;
                        let marker = CreateSolidBrush(MARKER_COLOUR);
                        let square = RECT {
                            left,
                            top,
                            right: left + side,
                            bottom: top + side,
                        };
                        FillRect(dc, &square, marker);
                        let _ = DeleteObject(HGDIOBJ(marker.0));
                        let text_left = left + side + scaled(PILL_PADDING, state.scale);
                        draw_text(dc, state, &state.pill_text, text_left, height);
                    }
                }
            }
        });
        let _ = EndPaint(window, &paint);
    }
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: called by Windows on the bar's thread with valid arguments.
    unsafe {
        match message {
            WM_PAINT => {
                paint(window);
                LRESULT(0)
            }
            WM_TIMER if wparam.0 == TIMER_ID => {
                if !read_commands(window) {
                    let _ = DestroyWindow(window);
                }
                LRESULT(0)
            }
            WM_LBUTTONDOWN => {
                pressed(window);
                LRESULT(0)
            }
            WM_COMMAND if wparam.0 & 0xFFFF == BUTTON_ID => {
                disconnect_all();
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use std::time::{Duration, Instant};

    fn bar_window() -> Option<HWND> {
        let class = wide(CLASS);
        let title = wide(BAR_TITLE);
        // SAFETY: two NUL-terminated strings that outlive the call.
        unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr())) }.ok()
    }

    /// Under Wine or on Windows: the bar comes up, takes new names and goes
    /// away on Close.
    #[test]
    fn notice_bar_on_windows_opens_renames_and_closes() {
        let bar = start(vec!["Kim".into()]).unwrap();
        assert!(bar_window().is_some(), "the bar window exists");
        bar.send(BarCommand::Names(vec!["Kim".into(), "Lee".into()]))
            .unwrap();
        bar.send(BarCommand::Close).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while bar_window().is_some() {
            assert!(Instant::now() < deadline, "the bar closed");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
