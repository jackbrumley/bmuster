//! The program's icon as a compiled Windows resource file (`.res`), which
//! the MSVC linker takes as an input like an object file (SPEC-BRAND-ICON).
//! `build.rs` writes it, so the build needs no resource compiler: it holds
//! what `rc.exe` makes from `1 ICON "bmuster.ico"`: one `RT_ICON` resource
//! per image and one `RT_GROUP_ICON` listing them. Explorer shows the first
//! icon group as the program's icon. The same file carries the program's
//! version details (`RT_VERSION`). Compiled into `build.rs` and the tests
//! only.

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

const RT_VERSION: u16 = 16;
/// The version resource's id, as `rc.exe` writes `VS_VERSION_INFO`.
const VERSION_ID: u16 = 1;
/// `MOVEABLE | PURE`, as `rc.exe` writes a version resource.
const VERSION_FLAGS: u16 = 0x0030;
/// US English, Unicode: the one string table and its translation entry.
const STRING_TABLE: &str = "040904B0";
const CODE_PAGE: u16 = 0x04B0;

/// One version-information block: its length, value length and type, its
/// key as UTF-16 with a terminator, then the value and the children, each
/// starting on a four-byte boundary.
fn version_block(
    key: &str,
    value: &[u8],
    value_length: u16,
    text: bool,
    children: &[Vec<u8>],
) -> Vec<u8> {
    let mut out = vec![0, 0];
    out.extend(value_length.to_le_bytes());
    out.extend(u16::from(text).to_le_bytes());
    out.extend(utf16(key));
    out.resize(out.len().next_multiple_of(4), 0);
    out.extend(value);
    for child in children {
        out.resize(out.len().next_multiple_of(4), 0);
        out.extend(child);
    }
    let length = u16::try_from(out.len()).unwrap_or(u16::MAX);
    out[..2].copy_from_slice(&length.to_le_bytes());
    out
}

/// UTF-16LE with a terminating zero.
fn utf16(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect()
}

/// The numeric parts of a version such as `0.4.25` or `0.1.0-dev.x`, for
/// the fixed file version (`major.minor.patch.0`).
fn version_numbers(version: &str) -> [u16; 4] {
    let core = version.split(['-', '+']).next().unwrap_or("");
    let mut parts = core.split('.').map(|part| part.parse::<u16>().unwrap_or(0));
    [
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        0,
    ]
}

/// The program's details as Explorer shows them under Properties > Details,
/// and as antivirus products read them: one `RT_VERSION` resource, as
/// `rc.exe` makes from a `VS_VERSION_INFO` block.
pub fn version_resource(out: &mut Vec<u8>, version: &str) {
    let [major, minor, patch, build] = version_numbers(version);
    let high = |a: u16, b: u16| (u32::from(a) << 16) | u32::from(b);
    let mut fixed = Vec::new();
    for value in [
        0xFEEF_04BD_u32, // signature
        0x0001_0000,     // structure version
        high(major, minor),
        high(patch, build),
        high(major, minor),
        high(patch, build),
        0x3F,    // flags mask
        0,       // flags
        0x40004, // VOS_NT_WINDOWS32
        1,       // VFT_APP
        0,       // subtype
        0,       // date
        0,
    ] {
        fixed.extend(value.to_le_bytes());
    }
    let strings: Vec<Vec<u8>> = [
        ("CompanyName", "BMuster"),
        ("FileDescription", "BMuster agent"),
        ("FileVersion", version),
        ("InternalName", "bmuster-agent"),
        (
            "LegalCopyright",
            "Copyright (C) Jack Brumley. Free software under the GNU AGPLv3.",
        ),
        ("OriginalFilename", "bmuster-agent.exe"),
        ("ProductName", "BMuster"),
        ("ProductVersion", version),
        ("Comments", "Self-hosted remote access. https://bmuster.com"),
    ]
    .iter()
    .map(|(key, value)| {
        let characters = u16::try_from(value.encode_utf16().count() + 1).unwrap_or(u16::MAX);
        version_block(key, &utf16(value), characters, true, &[])
    })
    .collect();
    let table = version_block(STRING_TABLE, &[], 0, true, &strings);
    let string_info = version_block("StringFileInfo", &[], 0, true, &[table]);
    let mut translation = Vec::new();
    translation.extend(LANGUAGE.to_le_bytes());
    translation.extend(CODE_PAGE.to_le_bytes());
    let var = version_block("Translation", &translation, 4, false, &[]);
    let var_info = version_block("VarFileInfo", &[], 0, true, &[var]);
    let fixed_length = u16::try_from(fixed.len()).unwrap_or(u16::MAX);
    let root = version_block(
        "VS_VERSION_INFO",
        &fixed,
        fixed_length,
        false,
        &[string_info, var_info],
    );
    push_resource(out, RT_VERSION, VERSION_ID, VERSION_FLAGS, LANGUAGE, &root);
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

    /// Reads one version block: (key, value, children).
    fn read_block(bytes: &[u8]) -> (String, Vec<u8>, Vec<Vec<u8>>, u16) {
        let length = u16::from_le_bytes([bytes[0], bytes[1]]) as usize;
        let value_length = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        let text = u16::from_le_bytes([bytes[4], bytes[5]]);
        let mut at = 6;
        let mut key = Vec::new();
        loop {
            let unit = u16::from_le_bytes([bytes[at], bytes[at + 1]]);
            at += 2;
            if unit == 0 {
                break;
            }
            key.push(unit);
        }
        at = at.next_multiple_of(4);
        let value_bytes = if text == 1 {
            value_length * 2
        } else {
            value_length
        };
        let value = bytes[at..at + value_bytes].to_vec();
        at += value_bytes;
        let mut children = Vec::new();
        while at.next_multiple_of(4) < length {
            at = at.next_multiple_of(4);
            let child_length = u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize;
            children.push(bytes[at..at + child_length].to_vec());
            at += child_length;
        }
        assert_eq!(at, length, "block length");
        (String::from_utf16(&key).unwrap(), value, children, text)
    }

    fn text_value(value: &[u8]) -> String {
        let units: Vec<u16> = value
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        String::from_utf16(&units).unwrap()
    }

    /// SPEC-BRAND-ICON W6: the program carries its name, publisher,
    /// description and version, as Explorer and antivirus products read them.
    #[test]
    fn the_program_carries_its_version_details() {
        let mut res = Vec::new();
        version_resource(&mut res, "0.4.25");
        assert_eq!(u32_at(&res, 4), 32, "header size");
        let kind = u16::from_le_bytes([res[10], res[11]]);
        let name = u16::from_le_bytes([res[14], res[15]]);
        assert_eq!((kind, name), (RT_VERSION, VERSION_ID));
        let size = u32_at(&res, 0) as usize;
        let (key, fixed, children, _) = read_block(&res[32..32 + size]);
        assert_eq!(key, "VS_VERSION_INFO");
        assert_eq!(u32_at(&fixed, 0), 0xFEEF_04BD);
        assert_eq!(u32_at(&fixed, 8), 4, "file version 0.4");
        assert_eq!(u32_at(&fixed, 12), 25 << 16, "file version .25.0");
        let (string_key, _, tables, _) = read_block(&children[0]);
        assert_eq!(string_key, "StringFileInfo");
        let (table_key, _, entries, _) = read_block(&tables[0]);
        assert_eq!(table_key, STRING_TABLE);
        let found: Vec<(String, String)> = entries
            .iter()
            .map(|entry| {
                let (key, value, _, text) = read_block(entry);
                assert_eq!(text, 1);
                (key, text_value(&value))
            })
            .collect();
        for wanted in [
            ("CompanyName", "BMuster"),
            ("FileDescription", "BMuster agent"),
            ("FileVersion", "0.4.25"),
            ("OriginalFilename", "bmuster-agent.exe"),
            ("ProductName", "BMuster"),
            ("ProductVersion", "0.4.25"),
        ] {
            assert!(
                found.contains(&(wanted.0.to_string(), wanted.1.to_string())),
                "{wanted:?}"
            );
        }
        let (var_key, _, vars, _) = read_block(&children[1]);
        assert_eq!(var_key, "VarFileInfo");
        let (translation_key, translation, _, _) = read_block(&vars[0]);
        assert_eq!(translation_key, "Translation");
        assert_eq!(translation, vec![0x09, 0x04, 0xB0, 0x04]);
    }

    /// A development version keeps its numbers in the fixed version.
    #[test]
    fn a_development_version_keeps_its_numbers() {
        assert_eq!(version_numbers("0.1.0-dev.20261113"), [0, 1, 0, 0]);
        assert_eq!(version_numbers("1.22.333"), [1, 22, 333, 0]);
    }
}
