//! The double-click gate for the tray icon's left-click toggle.
//!
//! Live QA (2026-07-16, instrumented — see `docs/research/live-qa-first-run.md`)
//! captured what Windows actually delivers for a tray double-click:
//!
//!   Click{Down} → Click{Up} → DoubleClick(+129ms) → Click{Up}
//!
//! The second physical press becomes `WM_LBUTTONDBLCLK`, but the second RELEASE
//! still arrives as a plain `Click{Up}` — so a naive toggle-on-every-Up runs
//! twice per double-click and the window opens and closes again. To a user,
//! double-clicking the icon "does nothing" (Quacket QA issue #4, which was
//! written as a fake report and turned out to be real).
//!
//! The gate: act on a `Click{Up}`, then swallow any further `Click{Up}` inside
//! the user's own double-click interval — the whole burst is one gesture. A
//! single click stays zero-latency; a double-click toggles ONCE (the window
//! opens and stays open, which is what "double click should open it" expects).
//! The `DoubleClick` event itself needs no handler: it was never a `Click{Up}`.

use std::time::{Duration, Instant};

pub struct ClickGate {
    threshold: Duration,
    last: Option<Instant>,
}

impl ClickGate {
    pub const fn new(threshold: Duration) -> Self {
        Self { threshold, last: None }
    }

    /// True when this click starts a new gesture; false when it is the tail of
    /// the previous one and must be swallowed.
    pub fn admit(&mut self, now: Instant) -> bool {
        let fresh = match self.last {
            Some(prev) => now.duration_since(prev) >= self.threshold,
            None => true,
        };
        if fresh {
            self.last = Some(now);
        }
        fresh
    }
}

/// The user's real double-click interval, not a hardcoded guess — accessibility
/// settings push this as high as 900 ms, and the gate must match what the OS
/// itself would call a double-click on THIS machine.
#[cfg(windows)]
pub fn double_click_interval() -> Duration {
    // SAFETY: no arguments, no pointers; returns the SPI_GETDOUBLECLICKTIME value.
    Duration::from_millis(unsafe { windows_sys::Win32::UI::Input::KeyboardAndMouse::GetDoubleClickTime() } as u64)
}

#[cfg(not(windows))]
pub fn double_click_interval() -> Duration {
    Duration::from_millis(500)
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: Duration = Duration::from_millis(500);

    #[test]
    fn the_first_click_acts_immediately() {
        let mut gate = ClickGate::new(T);
        assert!(gate.admit(Instant::now()));
    }

    #[test]
    fn the_double_click_tail_is_swallowed() {
        // The exact captured sequence: second Up ~129ms after the first.
        let mut gate = ClickGate::new(T);
        let first = Instant::now();
        assert!(gate.admit(first));
        assert!(!gate.admit(first + Duration::from_millis(129)));
    }

    #[test]
    fn a_later_single_click_acts_again() {
        let mut gate = ClickGate::new(T);
        let first = Instant::now();
        assert!(gate.admit(first));
        assert!(gate.admit(first + Duration::from_millis(501)));
    }

    #[test]
    fn a_triple_click_burst_is_still_one_gesture_then_a_new_one() {
        // The swallowed tail must NOT extend the window: the gesture is anchored
        // to the click that ACTED, or a click-happy user could lock themselves out.
        let mut gate = ClickGate::new(T);
        let first = Instant::now();
        assert!(gate.admit(first));
        assert!(!gate.admit(first + Duration::from_millis(129)));
        assert!(!gate.admit(first + Duration::from_millis(258)));
        assert!(gate.admit(first + Duration::from_millis(500)));
    }
}
