//! Windows command lines: the service starts the helper with one string,
//! which the helper's C runtime splits back into arguments.

/// Quotes one argument the way `CommandLineToArgvW` and the C runtime parse
/// it: plain words stay as they are; anything else goes in quotes, with
/// backslashes doubled before a quote (escaped) and at the end.
pub fn quote(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_string();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for c in argument.chars() {
        match c {
            '\\' => {
                backslashes += 1;
                quoted.push('\\');
            }
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                backslashes = 0;
                quoted.push(c);
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes));
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::quote;

    #[test]
    fn helper_arguments_are_quoted_for_windows() {
        assert_eq!(quote("desktop-helper"), "desktop-helper");
        assert_eq!(quote(r"C:\ProgramData\BMuster"), r"C:\ProgramData\BMuster");
        assert_eq!(
            quote(r"C:\Program Files\BMuster\bmuster-agent.exe"),
            r#""C:\Program Files\BMuster\bmuster-agent.exe""#
        );
        assert_eq!(quote(r"C:\Data Dir\"), r#""C:\Data Dir\\""#);
        assert_eq!(quote(r#"a"b"#), r#""a\"b""#);
        assert_eq!(quote(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote(""), r#""""#);
    }
}
