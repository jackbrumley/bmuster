//! `bmuster-agent kms-probe --png <path>` (SPEC-CONSOLE-CAPTURE W9): the
//! console helper's reader run in-process by a person checking a machine.

use anyhow::{Context as _, Result};
use bmuster_desktop::capture::kms::compose::describe;
use bmuster_desktop::capture::kms::device::KmsReader;
use bmuster_desktop::capture::kms::{KmsSource, PlaneKind};
use std::path::{Path, PathBuf};

/// `bmuster-agent kms-probe --png <path>`: prints what KMS shows and writes
/// one PNG per display (and its cursor) next to `png`, named after the
/// display. Run as root on the machine; nothing is sent anywhere.
pub fn probe(png: &Path) -> Result<()> {
    println!(
        "BMuster KMS probe (bmuster-agent {})",
        crate::updates::VERSION
    );
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if uid != 0 {
        println!("note: running as uid {uid}; reading framebuffers needs root (CAP_SYS_ADMIN)");
    }
    let mut reader = KmsReader::open().map_err(|e| anyhow::anyhow!("{e}"))?;
    for card in reader.cards() {
        println!(
            "\n{} ({}), render node {}",
            card.name,
            card.path.display(),
            card.render_node()
                .map_or("none".to_string(), |p| p.display().to_string())
        );
        let resources = match card.resources() {
            Ok(resources) => resources,
            Err(error) => {
                println!("  cannot read resources: {error}");
                continue;
            }
        };
        for connector in &resources.connectors {
            println!(
                "  connector {} {}: {}{}",
                connector.id,
                connector.name,
                if connector.connected {
                    "connected"
                } else {
                    "disconnected"
                },
                connector
                    .crtc_id
                    .map_or(String::new(), |crtc| format!(", CRTC {crtc}"))
            );
        }
        for crtc in &resources.crtcs {
            match &crtc.mode {
                Some(mode) => println!(
                    "  CRTC {}: {}x{}@{} from ({}, {}) of framebuffer {}",
                    crtc.id, mode.width, mode.height, mode.refresh, crtc.x, crtc.y, crtc.fb_id
                ),
                None => println!("  CRTC {}: off", crtc.id),
            }
        }
        let count = |kind| resources.planes.iter().filter(|p| p.kind == kind).count();
        println!(
            "  planes: {} primary, {} cursor, {} overlay (only those in use are listed)",
            count(PlaneKind::Primary),
            count(PlaneKind::Cursor),
            count(PlaneKind::Overlay)
        );
        for plane in &resources.planes {
            if plane.fb_id == 0 {
                continue;
            }
            let info = card.framebuffer_info(plane.fb_id);
            println!(
                "  CRTC {}: {}",
                plane.crtc_id,
                describe(plane, info.as_ref().ok())
            );
            match info {
                Ok(info) => println!(
                    "    pitches {:?}{}",
                    info.pitches,
                    if info.has_handles {
                        ""
                    } else {
                        " (handles withheld: not root)"
                    }
                ),
                Err(error) => println!("    cannot describe the framebuffer: {error}"),
            }
        }
    }
    let displays = reader.displays().map_err(|e| anyhow::anyhow!("{e}"))?;
    println!("\n{} display(s)", displays.len());
    if displays.is_empty() {
        println!("  {}", bmuster_desktop::capture::kms::SCREEN_OFF);
    }
    for display in &displays {
        println!(
            "  {} ({}): {}x{} at ({}, {}), CRTC {}",
            display.id,
            display.name,
            display.width,
            display.height,
            display.x,
            display.y,
            display.crtc_id
        );
        let path = named(png, &display.id);
        match reader.capture(&display.id, true) {
            Ok(Some(frame)) => {
                let mut rgba = Vec::with_capacity(frame.data.len());
                for pixel in frame.data.chunks_exact(4) {
                    rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], 0xFF]);
                }
                write_png(&path, frame.width, frame.height, &rgba)?;
                println!("    captured: {}", path.display());
            }
            Ok(None) => println!("    captured nothing (unchanged)"),
            Err(error) => println!("    capture failed: {error}"),
        }
        match reader.cursor(&display.id) {
            Ok(cursor) if cursor.visible => {
                println!(
                    "    cursor at ({}, {}), shape {:08x}",
                    cursor.x, cursor.y, cursor.shape
                );
                if let Ok(Some(image)) = reader.cursor_image(cursor.shape) {
                    let path = named(png, &format!("{}-cursor", display.id));
                    write_png(&path, image.width, image.height, &image.rgba)?;
                    println!("    cursor image: {}", path.display());
                }
            }
            Ok(_) => println!("    no cursor plane in use"),
            Err(error) => println!("    cursor failed: {error}"),
        }
    }
    Ok(())
}

/// `dir/name.png` becomes `dir/name-<suffix>.png`.
pub(super) fn named(png: &Path, suffix: &str) -> PathBuf {
    let stem = png
        .file_stem()
        .map_or("kms".into(), |s| s.to_string_lossy().into_owned());
    png.with_file_name(format!("{stem}-{suffix}.png"))
}

fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<()> {
    let file =
        std::fs::File::create(path).with_context(|| format!("Cannot write {}", path.display()))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header()?;
    writer.write_image_data(rgba)?;
    writer.finish()?;
    Ok(())
}
