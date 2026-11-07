//! Ctrl+Alt+Del from software: `SendSAS` in `sas.dll` (SPEC-DESKTOP 5.3).
//! Only a service may call it, and only while the `SoftwareSASGeneration`
//! policy allows services (see [`super::sas_policy`]); otherwise Windows
//! ignores the call without an error. Loaded at run time so neither the
//! MSVC nor the GNU build needs an import library for `sas.dll`.

use ::windows::core::{s, w};
use ::windows::Win32::Foundation::FreeLibrary;
use ::windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

type SendSas = unsafe extern "system" fn(as_user: i32);

/// Sends the secure attention sequence to the console session, as a
/// service (not as the user, `AsUser = FALSE`).
pub fn send_sas() -> Result<(), String> {
    // SAFETY: sas.dll's SendSAS takes one BOOL and returns nothing; the
    // library stays loaded for the call and is freed after it.
    unsafe {
        let library = LoadLibraryW(w!("sas.dll")).map_err(|e| format!("loading sas.dll: {e}"))?;
        let result = match GetProcAddress(library, s!("SendSAS")) {
            Some(address) => {
                let send: SendSas =
                    std::mem::transmute::<unsafe extern "system" fn() -> isize, SendSas>(address);
                send(0);
                Ok(())
            }
            None => Err("sas.dll has no SendSAS".to_string()),
        };
        let _ = FreeLibrary(library);
        result
    }
}
