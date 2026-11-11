//! The program's icon as a compiled Windows resource file (`.res`), which
//! the MSVC linker takes as an input like an object file (SPEC-BRAND-ICON).
//! `build.rs` writes it, so the build needs no resource compiler: it holds
//! what `rc.exe` makes from `1 ICON "bmuster.ico"`: one `RT_ICON` resource
//! per image and one `RT_GROUP_ICON` listing them. Explorer shows the first
//! icon group as the program's icon. Compiled into `build.rs` and the
//! tests only.

use super::ico::Image;

const RT_ICON: u16 = 3;
const RT_GROUP_ICON: u16 = 14;
/// The icon group's id: the program's only icon.
pub const GROUP_ID: u16 = 1;
/// `MOVEABLE | DISCARDABLE`, and `PURE` for the group, as `rc.exe` writes.
const ICON_FLAGS: u16 = 0x1010;
const GROUP_FLAGS: u16 = 0x1030;
/// US English, as `rc.exe` writes by default.
const LANGUAGE: u16 = 0x0409;

/// One resource: its header (numeric type and name), then its data padded
/// to four bytes.
fn push_resource(out: &mut Vec<u8>, kind: u16, name: u16, flags: u16, language: u16, data: &[u8]) {
    let data_size = u32::try_from(data.len()).unwrap_or(u32::MAX);
    out.extend(data_size.to_le_bytes());
    out.extend(32u32.to_le_bytes());
    out.extend([0xFF, 0xFF]);
    out.extend(kind.to_le_bytes());
    out.extend([0xFF, 0xFF]);
    out.extend(name.to_le_bytes());
    out.extend(0u32.to_le_bytes()); // DataVersion
    out.extend(flags.to_le_bytes());
    out.extend(language.to_le_bytes());
    out.extend(0u32.to_le_bytes()); // Version
    out.extend(0u32.to_le_bytes()); // Characteristics
    out.extend(data);
    out.resize(out.len().next_multiple_of(4), 0);
}

/// The `.res` file for an icon made of `images` (32-bit colour each).
pub fn icon_resource(images: &[Image<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    // Every .res file starts with an empty resource.
    push_resource(&mut out, 0, 0, 0, 0, &[]);
    let mut group = Vec::new();
    group.extend(0u16.to_le_bytes());
    group.extend(1u16.to_le_bytes());
    group.extend(
        u16::try_from(images.len())
            .unwrap_or(u16::MAX)
            .to_le_bytes(),
    );
    for (index, image) in images.iter().enumerate() {
        let id = u16::try_from(index + 1).unwrap_or(u16::MAX);
        push_resource(&mut out, RT_ICON, id, ICON_FLAGS, LANGUAGE, image.data);
        // 256 is written as 0, as in the icon file.
        let edge = u8::try_from(image.edge).unwrap_or(0);
        group.extend([edge, edge, 0, 0]);
        group.extend(1u16.to_le_bytes()); // planes
        group.extend(32u16.to_le_bytes()); // bits per pixel
        let size = u32::try_from(image.data.len()).unwrap_or(u32::MAX);
        group.extend(size.to_le_bytes());
        group.extend(id.to_le_bytes());
    }
    push_resource(
        &mut out,
        RT_GROUP_ICON,
        GROUP_ID,
        GROUP_FLAGS,
        LANGUAGE,
        &group,
    );
    out
}

#[cfg(test)]
mod tests {
    use super::super::ico::images;
    use super::*;

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    /// SPEC-BRAND-ICON W2: the program's icon resource holds every image of
    /// bmuster.ico and a group naming them.
    #[test]
    fn the_program_icon_resource_holds_every_image() {
        let ico = include_bytes!("../../assets/bmuster.ico");
        let found = images(ico).unwrap();
        let res = icon_resource(&found);
        // The empty first resource.
        assert_eq!(&res[..8], &[0, 0, 0, 0, 32, 0, 0, 0]);
        assert_eq!(&res[8..16], &[0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0]);
        let mut at = 32;
        let mut seen = Vec::new();
        while at < res.len() {
            let size = u32_at(&res, at) as usize;
            assert_eq!(u32_at(&res, at + 4), 32, "header size");
            let kind = u16::from_le_bytes([res[at + 10], res[at + 11]]);
            let name = u16::from_le_bytes([res[at + 14], res[at + 15]]);
            seen.push((kind, name, res[at + 32..at + 32 + size].to_vec()));
            at = (at + 32 + size).next_multiple_of(4);
        }
        assert_eq!(at, res.len());
        assert_eq!(seen.len(), found.len() + 1);
        for (index, image) in found.iter().enumerate() {
            let id = u16::try_from(index + 1).unwrap();
            assert_eq!(seen[index], (RT_ICON, id, image.data.to_vec()));
        }
        let (kind, name, group) = seen.last().unwrap();
        assert_eq!((*kind, *name), (RT_GROUP_ICON, GROUP_ID));
        assert_eq!(&group[..6], &[0, 0, 1, 0, 8, 0]);
        // The 256px entry: width and height 0, 32 bits, its id last.
        let last = &group[6 + 14 * 7..];
        assert_eq!(&last[..6], &[0, 0, 0, 0, 1, 0]);
        assert_eq!(u16::from_le_bytes([last[6], last[7]]), 32);
        assert_eq!(u32_at(last, 8) as usize, found[7].data.len());
        assert_eq!(u16::from_le_bytes([last[12], last[13]]), 8);
    }
}
