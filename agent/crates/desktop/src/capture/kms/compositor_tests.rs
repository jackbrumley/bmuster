use super::*;

fn session(kind: &str, class: &str, user: &str, desktop: &str) -> HashMap<String, String> {
    [
        ("Type", kind),
        ("Class", class),
        ("User", user),
        ("Desktop", desktop),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect()
}

/// SPEC-DESKTOP-ALL-SCREENS A12.
#[test]
fn compositor_is_asked_only_on_a_persons_wayland_desktop() {
    assert_eq!(
        layout_owner(&session("wayland", "user", "1000", "gnome")),
        Ok(LayoutOwner {
            uid: 1000,
            compositor: Some(Compositor::Mutter)
        })
    );
    assert_eq!(
        layout_owner(&session("wayland", "greeter", "42", "KDE")),
        Err("the sign-in screen".into())
    );
    assert_eq!(
        layout_owner(&session("tty", "user", "1000", "")),
        Err("a tty user session".into())
    );
    assert_eq!(
        layout_owner(&HashMap::new()),
        Err("no session on the screen".into())
    );
    for uid in ["0", "999", "65534", "jack"] {
        assert!(
            layout_owner(&session("wayland", "user", uid, "KDE")).is_err(),
            "{uid}"
        );
    }
}

/// SPEC-DESKTOP-ALL-SCREENS K4: a Plasma session is KWin's, a GNOME one
/// mutter's, anything else is found out on the bus.
#[test]
fn compositor_is_chosen_from_the_sessions_desktop() {
    for desktop in ["KDE", "kde", "plasma", "plasmawayland", "KDE:plasma"] {
        assert_eq!(
            compositor_named(desktop),
            Some(Compositor::KWin),
            "{desktop}"
        );
    }
    for desktop in ["gnome", "GNOME", "gnome-classic", "ubuntu:GNOME"] {
        assert_eq!(
            compositor_named(desktop),
            Some(Compositor::Mutter),
            "{desktop}"
        );
    }
    for desktop in ["", "ubuntu", "sway", "kdenlive", "X-Cinnamon"] {
        assert_eq!(compositor_named(desktop), None, "{desktop}");
    }
    assert_eq!(
        layout_owner(&session("wayland", "user", "1000", "KDE")),
        Ok(LayoutOwner {
            uid: 1000,
            compositor: Some(Compositor::KWin)
        })
    );
    assert_eq!(
        layout_owner(&session("wayland", "user", "1000", "")),
        Ok(LayoutOwner {
            uid: 1000,
            compositor: None
        })
    );
}

/// Plasma 6 on the bus: KWin is there, mutter is not.
fn plasma_bus(uid: u32, call: &Call) -> Result<String, String> {
    assert_eq!(uid, 1000);
    match call.method {
        "NameHasOwner" => Ok(format!(
            r#"{{"type":"b","data":[{}]}}"#,
            call.arguments == ["s", "org.kde.KWin"]
        )),
        "supportInformation" => {
            assert_eq!(*call, kwin::CALL);
            let text = "Screens\n=======\nNumber of Screens: 2\n\nScreen 0:\n---------\n\
                        Name: DP-1\nEnabled: 1\nGeometry: 0,0,1920x1080\nScale: 1\n\
                        Screen 1:\n---------\nName: DP-2\nEnabled: 1\n\
                        Geometry: 0,1080,1920x1080\nScale: 1\n";
            Ok(serde_json::json!({"type": "s", "data": [text]}).to_string())
        }
        other => Err(format!("plasma has no {other}")),
    }
}

/// A bus with neither compositor on it.
fn empty_bus(_: u32, call: &Call) -> Result<String, String> {
    match call.method {
        "NameHasOwner" => Ok(r#"{"type":"b","data":[false]}"#.into()),
        other => Err(format!("nobody answers {other}")),
    }
}

/// SPEC-DESKTOP-ALL-SCREENS K4, K5: a KDE session reads KWin's layout,
/// named by logind or found on the bus; mutter is never asked there.
#[test]
fn compositor_reader_asks_kwin_on_a_kde_desktop() {
    let named = LayoutOwner {
        uid: 1000,
        compositor: Some(Compositor::KWin),
    };
    let layout = CompositorReader::with(named, plasma_bus).read().unwrap();
    assert_eq!(layout.compositor, Compositor::KWin);
    assert_eq!(layout.monitors[1].y, 1080);
    let found = LayoutOwner {
        uid: 1000,
        compositor: None,
    };
    let mut reader = CompositorReader::with(found, plasma_bus);
    assert_eq!(reader.read().unwrap(), layout);
    assert_eq!(reader.owner.compositor, Some(Compositor::KWin));
    // Logind said GNOME, but mutter is not there: the call's error.
    let wrong = LayoutOwner {
        uid: 1000,
        compositor: Some(Compositor::Mutter),
    };
    assert_eq!(
        CompositorReader::with(wrong, plasma_bus).read(),
        Err("plasma has no GetCurrentState".into())
    );
    assert_eq!(
        CompositorReader::with(found, empty_bus).read(),
        Err("neither mutter nor KWin is on the session bus".into())
    );
}

#[test]
fn compositor_calls_are_fixed_and_name_has_owner_is_read() {
    assert_eq!(
        kwin::CALL.busctl_arguments(),
        [
            "--user",
            "--json=short",
            "--no-pager",
            "--timeout=2",
            "call",
            "org.kde.KWin",
            "/KWin",
            "org.kde.KWin",
            "supportInformation"
        ]
    );
    assert_eq!(mutter::CALL.busctl_arguments()[8], "GetCurrentState");
    assert_eq!(
        mutter::IS_THERE.busctl_arguments()[8..],
        ["NameHasOwner", "s", "org.gnome.Mutter.DisplayConfig"]
    );
    assert_eq!(has_owner(r#"{"type":"b","data":[true]}"#), Ok(true));
    assert_eq!(has_owner(r#"{"type":"b","data":[false]}"#), Ok(false));
    assert!(has_owner(r#"{"type":"s","data":["yes"]}"#).is_err());
    assert!(has_owner("Call failed").is_err());
}

/// SPEC-DESKTOP-ALL-SCREENS A12: never as root; a missing runtime folder is
/// a reason, not a crash.
#[test]
fn compositor_reader_refuses_root_and_a_missing_runtime_folder() {
    assert_eq!(
        busctl_as(0, &kwin::CALL),
        Err("the desktop belongs to root".into())
    );
    let missing = CompositorReader::new(LayoutOwner {
        uid: 4_000_000,
        compositor: Some(Compositor::KWin),
    })
    .read()
    .unwrap_err();
    assert!(missing.starts_with("/run/user/4000000: "), "{missing}");
    assert_eq!(
        NoLayout("the greeter".into()).read(),
        Err("the greeter".into())
    );
}

/// Run by hand in a desktop session: asks this user's own bus which
/// compositor is there and reads its layout; elsewhere the reason comes
/// back.
#[test]
#[ignore]
fn compositor_reader_asks_this_users_session_bus() {
    // SAFETY: getuid has no arguments and cannot fail.
    let uid = unsafe { libc::getuid() };
    let owner = LayoutOwner {
        uid,
        compositor: None,
    };
    match CompositorReader::new(owner).read() {
        Ok(layout) => assert!(!layout.monitors.is_empty()),
        Err(reason) => assert_eq!(reason, "neither mutter nor KWin is on the session bus"),
    }
}
