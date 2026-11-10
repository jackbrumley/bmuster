//! What [`super::egl`] loads at run time: Khronos EGL, GLES 2 and GBM
//! constants and function tables (from the Khronos and Mesa headers), and
//! the `dlopen` wrapper. Tables are declared with `functions!`, which tests
//! use for the extra GBM calls they need.

use std::ffi::{c_char, c_void, CStr, CString};

pub(super) type Display = *mut c_void;
pub(super) type Context = *mut c_void;
pub(super) type Image = *mut c_void;
pub(super) type EglInt = i32;
pub(super) type EglBool = u32;

pub(super) const EGL_NONE: EglInt = 0x3038;
pub(super) const EGL_EXTENSIONS: EglInt = 0x3055;
pub(super) const EGL_HEIGHT: EglInt = 0x3056;
pub(super) const EGL_WIDTH: EglInt = 0x3057;
pub(super) const EGL_CONTEXT_CLIENT_VERSION: EglInt = 0x3098;
pub(super) const EGL_OPENGL_ES_API: u32 = 0x30A0;
pub(super) const EGL_PLATFORM_GBM_KHR: u32 = 0x31D7;
pub(super) const EGL_LINUX_DMA_BUF_EXT: u32 = 0x3270;
pub(super) const EGL_LINUX_DRM_FOURCC_EXT: EglInt = 0x3271;
/// FD, offset and pitch for each plane.
pub(super) const EGL_PLANE_ATTRIBUTES: [[EglInt; 3]; 4] = [
    [0x3272, 0x3273, 0x3274],
    [0x3275, 0x3276, 0x3277],
    [0x3278, 0x3279, 0x327A],
    [0x3440, 0x3441, 0x3442],
];
/// Modifier low and high words for each plane.
pub(super) const EGL_PLANE_MODIFIERS: [[EglInt; 2]; 4] = [
    [0x3443, 0x3444],
    [0x3445, 0x3446],
    [0x3447, 0x3448],
    [0x3449, 0x344A],
];
pub(super) const MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

pub(super) const GL_ONE: u32 = 1;
pub(super) const GL_TRIANGLE_STRIP: u32 = 0x0005;
pub(super) const GL_ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
pub(super) const GL_BLEND: u32 = 0x0BE2;
pub(super) const GL_COLOR_BUFFER_BIT: u32 = 0x4000;
pub(super) const GL_TEXTURE_2D: u32 = 0x0DE1;
pub(super) const GL_PACK_ALIGNMENT: u32 = 0x0D05;
pub(super) const GL_UNSIGNED_BYTE: u32 = 0x1401;
pub(super) const GL_FLOAT: u32 = 0x1406;
pub(super) const GL_RGBA: u32 = 0x1908;
pub(super) const GL_NEAREST: i32 = 0x2600;
pub(super) const GL_LINEAR: i32 = 0x2601;
pub(super) const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
pub(super) const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
pub(super) const GL_TEXTURE_WRAP_S: u32 = 0x2802;
pub(super) const GL_TEXTURE_WRAP_T: u32 = 0x2803;
pub(super) const GL_CLAMP_TO_EDGE: i32 = 0x812F;
pub(super) const GL_TEXTURE0: u32 = 0x84C0;
pub(super) const GL_FRAGMENT_SHADER: u32 = 0x8B30;
pub(super) const GL_VERTEX_SHADER: u32 = 0x8B31;
pub(super) const GL_COMPILE_STATUS: u32 = 0x8B81;
pub(super) const GL_LINK_STATUS: u32 = 0x8B82;
pub(super) const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
pub(super) const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
pub(super) const GL_FRAMEBUFFER: u32 = 0x8D40;
pub(super) const GL_TEXTURE_EXTERNAL_OES: u32 = 0x8D65;

/// A `dlopen`ed library, never closed.
pub(super) struct Library {
    name: &'static str,
    handle: *mut c_void,
}

impl Library {
    pub(super) fn open(name: &'static str) -> Result<Library, String> {
        let soname = CString::new(name).map_err(|_| format!("bad library name {name:?}"))?;
        // SAFETY: dlopen with a NUL-terminated name; the result is checked.
        let handle = unsafe { libc::dlopen(soname.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        if handle.is_null() {
            return Err(format!("{name} could not be loaded: {}", last_dl_error()));
        }
        Ok(Library { name, handle })
    }

    pub(super) fn symbol(&self, symbol: &CStr) -> Result<*mut c_void, String> {
        // SAFETY: dlsym on a live handle with a NUL-terminated name.
        let address = unsafe { libc::dlsym(self.handle, symbol.as_ptr()) };
        if address.is_null() {
            return Err(format!("{} has no {}", self.name, symbol.to_string_lossy()));
        }
        Ok(address)
    }
}

fn last_dl_error() -> String {
    // SAFETY: dlerror returns null or a NUL-terminated string valid until
    // the next dl call on this thread; it is copied at once.
    let message = unsafe { libc::dlerror() };
    if message.is_null() {
        return "unknown error".to_string();
    }
    // SAFETY: non-null, NUL-terminated, see above.
    unsafe { CStr::from_ptr(message) }
        .to_string_lossy()
        .into_owned()
}

/// Declares a table of C functions and loads it, each by its own name.
macro_rules! functions {
    ($table:ident { $($name:ident = $symbol:literal : fn($($argument:ty),*) $(-> $result:ty)?;)* }) => {
        pub(super) struct $table {
            $(pub(super) $name: unsafe extern "C" fn($($argument),*) $(-> $result)?,)*
        }

        impl $table {
            pub(super) fn load(find: &mut dyn FnMut(&CStr) -> Result<*mut c_void, String>) -> Result<Self, String> {
                Ok($table {
                    $($name: {
                        let symbol = CString::new($symbol).map_err(|e| e.to_string())?;
                        let address = find(&symbol)?;
                        // SAFETY: `address` is the non-null address of the C
                        // function of this name, whose signature is the one
                        // declared here (from the Khronos and GBM headers).
                        unsafe {
                            std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($argument),*) $(-> $result)?>(address)
                        }
                    },)*
                })
            }
        }
    };
}

functions!(Egl {
    egl_get_proc_address = "eglGetProcAddress": fn(*const c_char) -> *mut c_void;
    egl_initialize = "eglInitialize": fn(Display, *mut EglInt, *mut EglInt) -> EglBool;
    egl_query_string = "eglQueryString": fn(Display, EglInt) -> *const c_char;
    egl_bind_api = "eglBindAPI": fn(u32) -> EglBool;
    egl_create_context = "eglCreateContext": fn(Display, *mut c_void, Context, *const EglInt) -> Context;
    egl_make_current = "eglMakeCurrent": fn(Display, *mut c_void, *mut c_void, Context) -> EglBool;
    egl_destroy_context = "eglDestroyContext": fn(Display, Context) -> EglBool;
    egl_terminate = "eglTerminate": fn(Display) -> EglBool;
    egl_get_error = "eglGetError": fn() -> EglInt;
});

functions!(EglExtensions {
    egl_get_platform_display_ext = "eglGetPlatformDisplayEXT": fn(u32, *mut c_void, *const EglInt) -> Display;
    egl_create_image_khr = "eglCreateImageKHR": fn(Display, Context, u32, *mut c_void, *const EglInt) -> Image;
    egl_destroy_image_khr = "eglDestroyImageKHR": fn(Display, Image) -> EglBool;
    gl_eglimage_target_texture2_does = "glEGLImageTargetTexture2DOES": fn(u32, Image);
});

functions!(Gles {
    gl_gen_textures = "glGenTextures": fn(i32, *mut u32);
    gl_delete_textures = "glDeleteTextures": fn(i32, *const u32);
    gl_bind_texture = "glBindTexture": fn(u32, u32);
    gl_tex_parameteri = "glTexParameteri": fn(u32, u32, i32);
    gl_tex_image2_d = "glTexImage2D": fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void);
    gl_gen_framebuffers = "glGenFramebuffers": fn(i32, *mut u32);
    gl_delete_framebuffers = "glDeleteFramebuffers": fn(i32, *const u32);
    gl_bind_framebuffer = "glBindFramebuffer": fn(u32, u32);
    gl_framebuffer_texture2_d = "glFramebufferTexture2D": fn(u32, u32, u32, u32, i32);
    gl_check_framebuffer_status = "glCheckFramebufferStatus": fn(u32) -> u32;
    gl_create_shader = "glCreateShader": fn(u32) -> u32;
    gl_shader_source = "glShaderSource": fn(u32, i32, *const *const c_char, *const i32);
    gl_compile_shader = "glCompileShader": fn(u32);
    gl_get_shaderiv = "glGetShaderiv": fn(u32, u32, *mut i32);
    gl_delete_shader = "glDeleteShader": fn(u32);
    gl_create_program = "glCreateProgram": fn() -> u32;
    gl_attach_shader = "glAttachShader": fn(u32, u32);
    gl_bind_attrib_location = "glBindAttribLocation": fn(u32, u32, *const c_char);
    gl_link_program = "glLinkProgram": fn(u32);
    gl_get_programiv = "glGetProgramiv": fn(u32, u32, *mut i32);
    gl_use_program = "glUseProgram": fn(u32);
    gl_delete_program = "glDeleteProgram": fn(u32);
    gl_get_uniform_location = "glGetUniformLocation": fn(u32, *const c_char) -> i32;
    gl_uniform1i = "glUniform1i": fn(i32, i32);
    gl_uniform1f = "glUniform1f": fn(i32, f32);
    gl_clear_color = "glClearColor": fn(f32, f32, f32, f32);
    gl_clear = "glClear": fn(u32);
    gl_enable = "glEnable": fn(u32);
    gl_disable = "glDisable": fn(u32);
    gl_blend_func = "glBlendFunc": fn(u32, u32);
    gl_vertex_attrib_pointer = "glVertexAttribPointer": fn(u32, i32, u32, u8, i32, *const c_void);
    gl_enable_vertex_attrib_array = "glEnableVertexAttribArray": fn(u32);
    gl_active_texture = "glActiveTexture": fn(u32);
    gl_viewport = "glViewport": fn(i32, i32, i32, i32);
    gl_draw_arrays = "glDrawArrays": fn(u32, i32, i32);
    gl_pixel_storei = "glPixelStorei": fn(u32, i32);
    gl_read_pixels = "glReadPixels": fn(i32, i32, i32, i32, u32, u32, *mut c_void);
    gl_finish = "glFinish": fn();
    gl_get_error = "glGetError": fn() -> u32;
});

functions!(Gbm {
    gbm_create_device = "gbm_create_device": fn(i32) -> *mut c_void;
    gbm_device_destroy = "gbm_device_destroy": fn(*mut c_void);
});

/// For the tests' extra GBM calls.
#[cfg(test)]
pub(super) use functions;
