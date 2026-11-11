//! What the tray shows while someone is connected to the screen
//! (SPEC-DESKTOP 8.2, notice version 2): pure decisions, so each platform's
//! tray only draws them.

use bmuster_desktop::notice::bar_text;

/// The tray's title and tooltip: the notice bar's own words while someone
/// is connected ("Kim is connected (BMuster)"), the agent's state
/// otherwise.
pub fn title(state: &str, names: &[String]) -> String {
    if names.is_empty() {
        format!("BMuster: {state}")
    } else {
        bar_text(names)
    }
}

// Disconnect, the notification and the marked icon are the Linux tray's:
// on Windows the notice bar has them.
#[cfg(target_os = "linux")]
/// The menu item that ends every desktop session, when there is one:
/// "Disconnect Kim", or "Disconnect everyone" for several viewers. Either
/// way it is the bar's Disconnect, which ends them all.
pub fn disconnect_label(names: &[String]) -> Option<String> {
    match names {
        [] => None,
        [one] => Some(format!("Disconnect {one}")),
        _ => Some("Disconnect everyone".into()),
    }
}

#[cfg(target_os = "linux")]
/// The desktop notification for viewers who just joined:
/// "Kim is connected to this screen (BMuster)".
pub fn notification_text(joined: &[String]) -> Option<String> {
    let who = match joined {
        [] => return None,
        [one] => return Some(format!("{one} is connected to this screen (BMuster)")),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    Some(format!("{who} are connected to this screen (BMuster)"))
}

#[cfg(target_os = "linux")]
/// Tells who joined since the last look, so each viewer is announced once.
#[derive(Debug, Default)]
pub struct Arrivals {
    seen: Vec<String>,
}

#[cfg(target_os = "linux")]
impl Arrivals {
    /// The names in `names` that were not there last time (a second
    /// session for the same person counts as joining).
    pub fn update(&mut self, names: &[String]) -> Vec<String> {
        let mut left = self.seen.clone();
        let mut joined = Vec::new();
        for name in names {
            match left.iter().position(|seen| seen == name) {
                Some(index) => {
                    left.remove(index);
                }
                None => joined.push(name.clone()),
            }
        }
        self.seen = names.to_vec();
        joined
    }
}

#[cfg(target_os = "linux")]
/// The tray mark with a red dot in its lower right corner: the "someone is
/// connected" icon. `pixels` is StatusNotifierItem ARGB (network order),
/// `edge` pixels square.
pub fn connected_icon(edge: i32, pixels: &[u8]) -> Vec<u8> {
    const RED: [u8; 4] = [255, 0xDC, 0x26, 0x26];
    const WHITE: [u8; 4] = [255, 0xFF, 0xFF, 0xFF];
    let mut marked = pixels.to_vec();
    let size = f64::from(edge);
    let (centre, radius) = (size * 0.75, size * 0.22);
    for y in 0..edge {
        for x in 0..edge {
            let dx = f64::from(x) + 0.5 - centre;
            let dy = f64::from(y) + 0.5 - centre;
            let distance = (dx * dx + dy * dy).sqrt();
            let colour = if distance <= radius {
                RED
            } else if distance <= radius + 1.0 {
                WHITE
            } else {
                continue;
            };
            let at = ((y * edge + x) * 4) as usize;
            if let Some(pixel) = marked.get_mut(at..at + 4) {
                pixel.copy_from_slice(&colour);
            }
        }
    }
    marked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn tray_title_names_the_viewers_while_connected() {
        assert_eq!(title("Connected", &[]), "BMuster: Connected");
        assert_eq!(
            title("Connected", &names(&["Kim"])),
            "Kim is connected (BMuster)"
        );
        assert_eq!(
            title("Offline", &names(&["Kim", "Lee"])),
            "Kim and Lee are connected (BMuster)"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tray_disconnect_item_names_one_viewer_or_everyone() {
        assert_eq!(disconnect_label(&[]), None);
        assert_eq!(
            disconnect_label(&names(&["Kim"])).as_deref(),
            Some("Disconnect Kim")
        );
        assert_eq!(
            disconnect_label(&names(&["Kim", "Lee"])).as_deref(),
            Some("Disconnect everyone")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tray_notification_announces_each_viewer_once() {
        let mut arrivals = Arrivals::default();
        let joined = arrivals.update(&names(&["Kim"]));
        assert_eq!(
            notification_text(&joined).as_deref(),
            Some("Kim is connected to this screen (BMuster)")
        );
        assert_eq!(arrivals.update(&names(&["Kim"])), Vec::<String>::new());
        assert_eq!(notification_text(&[]), None);
        let joined = arrivals.update(&names(&["Kim", "Lee", "Sam"]));
        assert_eq!(
            notification_text(&joined).as_deref(),
            Some("Lee and Sam are connected to this screen (BMuster)")
        );
        // Leaving says nothing; coming back is a new connection.
        assert!(arrivals.update(&names(&["Lee"])).is_empty());
        assert_eq!(arrivals.update(&names(&["Lee", "Kim"])), names(&["Kim"]));
        // A second session for the same person.
        assert_eq!(
            arrivals.update(&names(&["Lee", "Kim", "Kim"])),
            names(&["Kim"])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn tray_connected_icon_adds_a_red_dot_and_keeps_the_rest() {
        let edge = 22;
        let plain = vec![0u8; (edge * edge * 4) as usize];
        let marked = connected_icon(edge, &plain);
        assert_eq!(marked.len(), plain.len());
        let at = |x: i32, y: i32| ((y * edge + x) * 4) as usize;
        let dot = at(16, 16);
        assert_eq!(&marked[dot..dot + 4], &[255, 0xDC, 0x26, 0x26]);
        assert_eq!(&marked[at(2, 2)..at(2, 2) + 4], &[0, 0, 0, 0]);
        assert_eq!(&marked[at(11, 5)..at(11, 5) + 4], &[0, 0, 0, 0]);
    }
}
