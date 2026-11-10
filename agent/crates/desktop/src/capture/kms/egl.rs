//! Tiled and compressed framebuffers through the GPU (SPEC-CONSOLE-CAPTURE,
//! Capture 3 and version 2): import each plane's dma-buf into EGL with its
//! modifier, draw it as a textured quad where the plane lands (scaled,
//! rotated, blended with its alpha), all into one plain RGBA texture with
//! GLES 2, and read the pixels back once. The maths is
//! [`super::compose::Placement`]'s, as on the CPU path.
//!
//! `libEGL.so.1`, `libGLESv2.so.2` and `libgbm.so.1` are opened with
//! `dlopen` the first time a tiled buffer appears, so the agent has no
//! link-time dependency on them: a machine without them still runs, and
//! capture reports which library is missing. The libraries stay loaded
//! once opened (Mesa does not support being unloaded).
//!
//! The context is surfaceless (`EGL_KHR_surfaceless_context`) on a GBM
//! device for the card's render node, so no display server is involved.

use super::compose::Placement;
use super::egl_api::*;
use super::Blend;
use crate::capture::Frame;
use std::ffi::{c_void, CStr, CString};
use std::fs::File;
use std::os::fd::{AsRawFd, BorrowedFd};
use std::path::Path;

/// The libraries a tiled screen needs, by soname.
#[derive(Debug, Clone, Copy)]
pub struct Libraries {
    pub egl: &'static str,
    pub gles: &'static str,
    pub gbm: &'static str,
}

pub const LIBRARIES: Libraries = Libraries {
    egl: "libEGL.so.1",
    gles: "libGLESv2.so.2",
    gbm: "libgbm.so.1",
};

/// One plane of a dma-buf.
#[derive(Debug, Clone, Copy)]
pub struct DmaPlane<'a> {
    pub fd: BorrowedFd<'a>,
    pub offset: u32,
    pub pitch: u32,
}

/// A framebuffer to import: up to four planes, one format and modifier.
#[derive(Debug)]
pub struct DmaBuffer<'a> {
    pub width: u32,
    pub height: u32,
    pub format: u32,
    /// `DRM_FORMAT_MOD_INVALID` when the buffer has none.
    pub modifier: u64,
    pub planes: &'a [DmaPlane<'a>],
}

const VERTEX_SHADER: &str = "attribute vec2 position;
attribute vec2 texture_position;
varying vec2 coordinate;
void main() {
  coordinate = texture_position;
  gl_Position = vec4(position, 0.0, 1.0);
}
";

const FRAGMENT_SHADER: &str = "#extension GL_OES_EGL_image_external : require
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform samplerExternalOES image;
uniform float plane_alpha;
uniform float pixel_alpha;
uniform float premultiplied;
varying vec2 coordinate;
void main() {
  vec4 colour = texture2D(image, coordinate);
  float alpha = mix(1.0, colour.a, pixel_alpha);
  vec3 rgb = mix(colour.rgb * alpha, colour.rgb, premultiplied);
  gl_FragColor = vec4(rgb, alpha) * plane_alpha;
}
";

/// The uniforms of the drawing program.
#[derive(Debug, Clone, Copy)]
struct Uniforms {
    image: i32,
    plane_alpha: i32,
    pixel_alpha: i32,
    premultiplied: i32,
}

/// The shader's pixel-alpha and pre-multiplied switches for a blend mode:
/// pre-multiplied colour is used as it is, coverage colour is multiplied
/// by its alpha, and none ignores the pixel's alpha.
fn blend_switches(blend: Blend) -> (f32, f32) {
    match blend {
        Blend::Premultiplied => (1.0, 1.0),
        Blend::Coverage => (1.0, 0.0),
        Blend::None => (0.0, 1.0),
    }
}

/// A GPU context for one card's render node.
pub struct Gpu {
    egl: Egl,
    extensions: EglExtensions,
    gl: Gles,
    gbm: Gbm,
    _render_node: File,
    device: *mut c_void,
    display: Display,
    context: Context,
    program: u32,
    uniforms: Uniforms,
    /// The texture and framebuffer drawn into, and their size.
    target: Option<(u32, u32, u32, u32)>,
    modifiers: bool,
}

impl Gpu {
    /// Opens the GPU behind `render_node` with the system's libraries.
    pub fn open(render_node: &Path) -> Result<Gpu, String> {
        Gpu::open_with(&LIBRARIES, render_node)
    }

    /// Opens the GPU with the named libraries (tests name missing ones).
    pub fn open_with(libraries: &Libraries, render_node: &Path) -> Result<Gpu, String> {
        let egl_library = Library::open(libraries.egl)?;
        let gles_library = Library::open(libraries.gles)?;
        let gbm_library = Library::open(libraries.gbm)?;
        let egl = Egl::load(&mut |name| egl_library.symbol(name))?;
        let gl = Gles::load(&mut |name| gles_library.symbol(name))?;
        let gbm = Gbm::load(&mut |name| gbm_library.symbol(name))?;
        let extensions = EglExtensions::load(&mut |name| {
            // SAFETY: eglGetProcAddress takes a NUL-terminated name and
            // returns null or the function's address.
            let address = unsafe { (egl.egl_get_proc_address)(name.as_ptr()) };
            if address.is_null() {
                Err(format!("EGL has no {}", name.to_string_lossy()))
            } else {
                Ok(address)
            }
        })?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(render_node)
            .map_err(|e| format!("Cannot open {}: {e}", render_node.display()))?;
        // SAFETY: gbm_create_device takes an open DRM descriptor, which
        // `file` keeps open for the device's life (it is dropped after).
        let device = unsafe { (gbm.gbm_create_device)(file.as_raw_fd()) };
        if device.is_null() {
            return Err(format!("GBM cannot use {}", render_node.display()));
        }
        let mut gpu = Gpu {
            egl,
            extensions,
            gl,
            gbm,
            _render_node: file,
            device,
            display: std::ptr::null_mut(),
            context: std::ptr::null_mut(),
            program: 0,
            uniforms: Uniforms {
                image: -1,
                plane_alpha: -1,
                pixel_alpha: -1,
                premultiplied: -1,
            },
            target: None,
            modifiers: false,
        };
        gpu.start()?;
        Ok(gpu)
    }

    fn egl_error(&self, what: &str) -> String {
        // SAFETY: eglGetError takes nothing and returns the thread's error.
        let code = unsafe { (self.egl.egl_get_error)() };
        format!("{what} failed (EGL error 0x{code:04x})")
    }

    /// Display, context and the drawing program.
    fn start(&mut self) -> Result<(), String> {
        // SAFETY: a GBM device is the native display of EGL_PLATFORM_GBM_KHR.
        self.display = unsafe {
            (self.extensions.egl_get_platform_display_ext)(
                EGL_PLATFORM_GBM_KHR,
                self.device,
                std::ptr::null(),
            )
        };
        if self.display.is_null() {
            return Err(self.egl_error("eglGetPlatformDisplay"));
        }
        let (mut major, mut minor) = (0, 0);
        // SAFETY: a valid display and two out-parameters.
        if unsafe { (self.egl.egl_initialize)(self.display, &mut major, &mut minor) } == 0 {
            // eglInitialize failed: nothing to terminate.
            let error = self.egl_error("eglInitialize");
            self.display = std::ptr::null_mut();
            return Err(error);
        }
        // SAFETY: an initialised display; the string is static in EGL.
        let extensions = unsafe { (self.egl.egl_query_string)(self.display, EGL_EXTENSIONS) };
        let extensions = if extensions.is_null() {
            String::new()
        } else {
            // SAFETY: non-null and NUL-terminated (EGL owns it).
            unsafe { CStr::from_ptr(extensions) }
                .to_string_lossy()
                .into_owned()
        };
        let has = |name: &str| extensions.split(' ').any(|e| e == name);
        for needed in [
            "EGL_EXT_image_dma_buf_import",
            "EGL_KHR_surfaceless_context",
            "EGL_KHR_no_config_context",
        ] {
            if !has(needed) {
                return Err(format!("EGL {major}.{minor} lacks {needed}"));
            }
        }
        self.modifiers = has("EGL_EXT_image_dma_buf_import_modifiers");
        // SAFETY: plain enum argument.
        if unsafe { (self.egl.egl_bind_api)(EGL_OPENGL_ES_API) } == 0 {
            return Err(self.egl_error("eglBindAPI"));
        }
        let attributes = [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE];
        // SAFETY: no config (EGL_KHR_no_config_context), no share context,
        // a NONE-terminated attribute list.
        self.context = unsafe {
            (self.egl.egl_create_context)(
                self.display,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                attributes.as_ptr(),
            )
        };
        if self.context.is_null() {
            return Err(self.egl_error("eglCreateContext"));
        }
        // SAFETY: surfaceless make-current on this thread.
        let current = unsafe {
            (self.egl.egl_make_current)(
                self.display,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                self.context,
            )
        };
        if current == 0 {
            return Err(self.egl_error("eglMakeCurrent"));
        }
        self.program = self.link()?;
        let location = |name: &str| -> Result<i32, String> {
            let text = CString::new(name).map_err(|e| e.to_string())?;
            // SAFETY: a linked program and a NUL-terminated name.
            Ok(unsafe { (self.gl.gl_get_uniform_location)(self.program, text.as_ptr()) })
        };
        self.uniforms = Uniforms {
            image: location("image")?,
            plane_alpha: location("plane_alpha")?,
            pixel_alpha: location("pixel_alpha")?,
            premultiplied: location("premultiplied")?,
        };
        Ok(())
    }

    fn shader(&self, kind: u32, source: &str) -> Result<u32, String> {
        let text = CString::new(source).map_err(|e| e.to_string())?;
        let pointer = text.as_ptr();
        let mut compiled = 0;
        // SAFETY: a current context; one NUL-terminated source string
        // (length null means "up to the NUL").
        let shader = unsafe {
            let shader = (self.gl.gl_create_shader)(kind);
            (self.gl.gl_shader_source)(shader, 1, &pointer, std::ptr::null());
            (self.gl.gl_compile_shader)(shader);
            (self.gl.gl_get_shaderiv)(shader, GL_COMPILE_STATUS, &mut compiled);
            shader
        };
        if compiled == 0 {
            // SAFETY: deleting the shader just made.
            unsafe { (self.gl.gl_delete_shader)(shader) };
            return Err("The GPU could not compile BMuster's copy shader".to_string());
        }
        Ok(shader)
    }

    fn link(&self) -> Result<u32, String> {
        let vertex = self.shader(GL_VERTEX_SHADER, VERTEX_SHADER)?;
        let fragment = self.shader(GL_FRAGMENT_SHADER, FRAGMENT_SHADER)?;
        let position = CString::new("position").map_err(|e| e.to_string())?;
        let texture_position = CString::new("texture_position").map_err(|e| e.to_string())?;
        let mut linked = 0;
        // SAFETY: a current context and two compiled shaders.
        let program = unsafe {
            let program = (self.gl.gl_create_program)();
            (self.gl.gl_attach_shader)(program, vertex);
            (self.gl.gl_attach_shader)(program, fragment);
            (self.gl.gl_bind_attrib_location)(program, 0, position.as_ptr());
            (self.gl.gl_bind_attrib_location)(program, 1, texture_position.as_ptr());
            (self.gl.gl_link_program)(program);
            (self.gl.gl_get_programiv)(program, GL_LINK_STATUS, &mut linked);
            (self.gl.gl_delete_shader)(vertex);
            (self.gl.gl_delete_shader)(fragment);
            program
        };
        if linked == 0 {
            // SAFETY: deleting the program just made.
            unsafe { (self.gl.gl_delete_program)(program) };
            return Err("The GPU could not link BMuster's copy shader".to_string());
        }
        Ok(program)
    }

    /// A texture and framebuffer of `width` × `height` to draw into.
    fn target(&mut self, width: u32, height: u32) -> Result<(), String> {
        if let Some((texture, framebuffer, w, h)) = self.target {
            if (w, h) == (width, height) {
                // SAFETY: binding the framebuffer this context made.
                unsafe { (self.gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, framebuffer) };
                return Ok(());
            }
            // SAFETY: deleting objects this context made.
            unsafe {
                (self.gl.gl_delete_framebuffers)(1, &framebuffer);
                (self.gl.gl_delete_textures)(1, &texture);
            }
            self.target = None;
        }
        let (mut texture, mut framebuffer) = (0, 0);
        // SAFETY: a current context; the texture has no initial data.
        let status = unsafe {
            (self.gl.gl_gen_textures)(1, &mut texture);
            (self.gl.gl_bind_texture)(GL_TEXTURE_2D, texture);
            (self.gl.gl_tex_image2_d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA as i32,
                width as i32,
                height as i32,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                std::ptr::null(),
            );
            (self.gl.gl_gen_framebuffers)(1, &mut framebuffer);
            (self.gl.gl_bind_framebuffer)(GL_FRAMEBUFFER, framebuffer);
            (self.gl.gl_framebuffer_texture2_d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                texture,
                0,
            );
            (self.gl.gl_check_framebuffer_status)(GL_FRAMEBUFFER)
        };
        self.target = Some((texture, framebuffer, width, height));
        if status != GL_FRAMEBUFFER_COMPLETE {
            return Err(format!(
                "The GPU cannot draw a {width}x{height} copy (0x{status:04x})"
            ));
        }
        Ok(())
    }

    fn import(&self, buffer: &DmaBuffer<'_>) -> Result<Image, String> {
        if buffer.planes.is_empty() || buffer.planes.len() > 4 {
            return Err(format!(
                "A framebuffer with {} planes cannot be imported",
                buffer.planes.len()
            ));
        }
        let explicit = buffer.modifier != MOD_INVALID;
        if explicit && !self.modifiers {
            return Err(format!(
                "EGL cannot import modifier 0x{:016x} (no EGL_EXT_image_dma_buf_import_modifiers)",
                buffer.modifier
            ));
        }
        let mut attributes = vec![
            EGL_WIDTH,
            buffer.width as EglInt,
            EGL_HEIGHT,
            buffer.height as EglInt,
            EGL_LINUX_DRM_FOURCC_EXT,
            buffer.format as EglInt,
        ];
        for (index, plane) in buffer.planes.iter().enumerate() {
            let [fd, offset, pitch] = EGL_PLANE_ATTRIBUTES[index];
            attributes.extend([
                fd,
                plane.fd.as_raw_fd(),
                offset,
                plane.offset as EglInt,
                pitch,
                plane.pitch as EglInt,
            ]);
            if explicit {
                let [low, high] = EGL_PLANE_MODIFIERS[index];
                attributes.extend([
                    low,
                    (buffer.modifier & 0xffff_ffff) as u32 as EglInt,
                    high,
                    (buffer.modifier >> 32) as u32 as EglInt,
                ]);
            }
        }
        attributes.push(EGL_NONE);
        // SAFETY: EGL_LINUX_DMA_BUF_EXT takes no client buffer and no
        // context; the attribute list is NONE-terminated and its descriptors
        // stay open for the call (EGL duplicates what it keeps).
        let image = unsafe {
            (self.extensions.egl_create_image_khr)(
                self.display,
                std::ptr::null_mut(),
                EGL_LINUX_DMA_BUF_EXT,
                std::ptr::null_mut(),
                attributes.as_ptr(),
            )
        };
        if image.is_null() {
            return Err(self.egl_error(&format!(
                "Importing the {}x{} {} framebuffer (modifier 0x{:016x})",
                buffer.width,
                buffer.height,
                super::convert::fourcc_name(buffer.format),
                buffer.modifier
            )));
        }
        Ok(image)
    }

    /// The layers drawn bottom first onto a black `width` × `height`
    /// canvas, as BGRX.
    pub fn compose(
        &mut self,
        width: u32,
        height: u32,
        layers: &[(DmaBuffer<'_>, Placement)],
    ) -> Result<Frame, String> {
        if width == 0 || height == 0 {
            return Err("The screen to copy is empty".to_string());
        }
        let mut images = Vec::with_capacity(layers.len());
        let mut result = Ok(());
        for (buffer, _) in layers {
            match self.import(buffer) {
                Ok(image) => images.push(image),
                Err(error) => {
                    result = Err(error);
                    break;
                }
            }
        }
        let result = result.and_then(|()| self.draw(width, height, layers, &images));
        for image in images {
            // SAFETY: destroying each image made above once; the textures
            // that used them are deleted in `draw`.
            unsafe { (self.extensions.egl_destroy_image_khr)(self.display, image) };
        }
        result
    }

    fn draw(
        &mut self,
        width: u32,
        height: u32,
        layers: &[(DmaBuffer<'_>, Placement)],
        images: &[Image],
    ) -> Result<Frame, String> {
        self.target(width, height)?;
        let quads: Vec<([f32; 8], [f32; 8])> = layers
            .iter()
            .map(|(_, placement)| placement.quad(width, height))
            .collect();
        let mut rgba = vec![0u8; width as usize * height as usize * 4];
        let mut textures = vec![0u32; images.len()];
        let uniforms = self.uniforms;
        // SAFETY: a current context; each external texture is bound to its
        // live image; the vertex arrays live in `quads` until after
        // glFinish; `rgba` holds exactly width × height × 4 bytes for
        // glReadPixels with pack alignment 1.
        let error = unsafe {
            (self.gl.gl_viewport)(0, 0, width as i32, height as i32);
            (self.gl.gl_clear_color)(0.0, 0.0, 0.0, 1.0);
            (self.gl.gl_clear)(GL_COLOR_BUFFER_BIT);
            (self.gl.gl_use_program)(self.program);
            (self.gl.gl_uniform1i)(uniforms.image, 0);
            (self.gl.gl_enable)(GL_BLEND);
            (self.gl.gl_blend_func)(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
            (self.gl.gl_active_texture)(GL_TEXTURE0);
            if !images.is_empty() {
                (self.gl.gl_gen_textures)(images.len() as i32, textures.as_mut_ptr());
            }
            for (index, ((_, placement), image)) in layers.iter().zip(images).enumerate() {
                let filter = if placement.scaled() {
                    GL_LINEAR
                } else {
                    GL_NEAREST
                };
                (self.gl.gl_bind_texture)(GL_TEXTURE_EXTERNAL_OES, textures[index]);
                (self.gl.gl_tex_parameteri)(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MIN_FILTER, filter);
                (self.gl.gl_tex_parameteri)(GL_TEXTURE_EXTERNAL_OES, GL_TEXTURE_MAG_FILTER, filter);
                (self.gl.gl_tex_parameteri)(
                    GL_TEXTURE_EXTERNAL_OES,
                    GL_TEXTURE_WRAP_S,
                    GL_CLAMP_TO_EDGE,
                );
                (self.gl.gl_tex_parameteri)(
                    GL_TEXTURE_EXTERNAL_OES,
                    GL_TEXTURE_WRAP_T,
                    GL_CLAMP_TO_EDGE,
                );
                (self.extensions.gl_eglimage_target_texture2_does)(GL_TEXTURE_EXTERNAL_OES, *image);
                let (pixel_alpha, premultiplied) = blend_switches(placement.blend);
                (self.gl.gl_uniform1f)(uniforms.plane_alpha, f32::from(placement.alpha) / 65535.0);
                (self.gl.gl_uniform1f)(uniforms.pixel_alpha, pixel_alpha);
                (self.gl.gl_uniform1f)(uniforms.premultiplied, premultiplied);
                let (positions, texture) = &quads[index];
                (self.gl.gl_vertex_attrib_pointer)(
                    0,
                    2,
                    GL_FLOAT,
                    0,
                    0,
                    positions.as_ptr() as *const c_void,
                );
                (self.gl.gl_enable_vertex_attrib_array)(0);
                (self.gl.gl_vertex_attrib_pointer)(
                    1,
                    2,
                    GL_FLOAT,
                    0,
                    0,
                    texture.as_ptr() as *const c_void,
                );
                (self.gl.gl_enable_vertex_attrib_array)(1);
                (self.gl.gl_draw_arrays)(GL_TRIANGLE_STRIP, 0, 4);
            }
            (self.gl.gl_disable)(GL_BLEND);
            (self.gl.gl_pixel_storei)(GL_PACK_ALIGNMENT, 1);
            (self.gl.gl_read_pixels)(
                0,
                0,
                width as i32,
                height as i32,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                rgba.as_mut_ptr() as *mut c_void,
            );
            (self.gl.gl_finish)();
            if !textures.is_empty() {
                (self.gl.gl_delete_textures)(textures.len() as i32, textures.as_ptr());
            }
            (self.gl.gl_get_error)()
        };
        if error != 0 {
            return Err(format!("The GPU copy failed (GL error 0x{error:04x})"));
        }
        let mut frame = Frame::new(width, height);
        for (from, to) in rgba.chunks_exact(4).zip(frame.data.chunks_exact_mut(4)) {
            to.copy_from_slice(&[from[2], from[1], from[0], 0xFF]);
        }
        Ok(frame)
    }
}

impl Drop for Gpu {
    fn drop(&mut self) {
        // SAFETY: each object is destroyed once, in reverse order of
        // creation, and only if it was made.
        unsafe {
            if !self.display.is_null() {
                if let Some((texture, framebuffer, _, _)) = self.target.take() {
                    (self.gl.gl_delete_framebuffers)(1, &framebuffer);
                    (self.gl.gl_delete_textures)(1, &texture);
                }
                if self.program != 0 {
                    (self.gl.gl_delete_program)(self.program);
                }
                (self.egl.egl_make_current)(
                    self.display,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                );
                if !self.context.is_null() {
                    (self.egl.egl_destroy_context)(self.display, self.context);
                }
                (self.egl.egl_terminate)(self.display);
            }
            (self.gbm.gbm_device_destroy)(self.device);
        }
    }
}

#[cfg(test)]
#[path = "egl_tests.rs"]
mod tests;
