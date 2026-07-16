/**
 * The one `<select>` in this app.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * A controlled `<select>` whose `value` matches none of its `<option>`s does NOT
 * render blank. The browser silently selects `option[0]`, READS IT BACK as the
 * value, and — because it considers that option already chosen — fires no change
 * event when the user picks the very thing on screen. So the control states
 * something the app does not hold, and cannot be corrected through itself. A
 * screen that misreports state AND cannot be fixed by using it is worse than no
 * screen.
 *
 * That defect has been found and fixed FOUR times, and each fix was local:
 *
 *   round 3  Settings › Assistant        fixed with a sentinel option
 *   round 4  Settings › Model            "the file's own header comment describes
 *                                         this failure while the code repeats it"
 *   round 4  Settings (all rows)         `PickerRow` — impossible, but only
 *                                         inside SettingsView.tsx
 *   round 5  Onboarding › Thinking effort  the first-run card read "low" with
 *                                         nothing stored
 *            Footer › Model / Thinking   the same raw pattern, still standing
 *
 * The invariant was enforced per-FILE, so every round the defect simply MOVED to
 * the next file. It is not a bug anyone keeps re-introducing out of carelessness;
 * it is the default behaviour of the platform primitive, so any surface that
 * reaches for that primitive gets it for free.
 *
 * Hence: the primitive is written down ONCE, here, and `raw-select.guard.test.ts`
 * fails the build if a raw `<select` appears in any other `.tsx` under `src/`. A
 * convention nobody CAN violate beats a convention everyone must remember —
 * "a picker that claims a choice nobody made" is not a thing the author of the
 * next surface can express, rather than something they have to know about.
 *
 * ── The rule it enforces ────────────────────────────────────────────────────
 *
 * The select's value is the option that `value` IDENTIFIES — never `value`
 * itself. The two differ exactly when the stored choice is stale or was never
 * made, which is the case worth being honest about, and then the row says so in
 * its own words while every real choice stays one click away. That is what makes
 * it correctable: the browser has nothing pre-selected, so picking any option
 * fires a change.
 */

/** The value a picker holds when nothing on offer is the choice in force. */
const UNSET = '';

export interface PickerOption {
  /** Passed back to `onPick` verbatim. Never shown. */
  value: string;
  /** Shown. Never passed back. */
  label: string;
}

export interface PickerProps {
  /** The visible name of the control, and its accessible label. */
  label: string;
  /** The STORED choice — any string, including one that no longer exists. */
  value: string | null;
  options: PickerOption[];
  /** Shown, and read back, when no option is in force. Real words, never blank. */
  placeholder: string;
  /** Only ever called with an option's `value`. The placeholder cannot reach it. */
  onPick: (value: string) => void;
  /** The wrapper's class — each surface styles its own row shape. */
  className: string;
  /** The label span's class, where a surface needs one. */
  labelClassName?: string;
  /** Empty options disable it regardless: nothing to pick is not a choice. */
  disabled?: boolean;
}

export function Picker({
  label,
  value,
  options,
  placeholder,
  onPick,
  className,
  labelClassName,
  disabled = false,
}: PickerProps) {
  const inForce = options.find((o) => o.value === value) ?? null;

  return (
    <label className={className}>
      <span className={labelClassName}>{label}</span>
      <select
        value={inForce?.value ?? UNSET}
        disabled={disabled || options.length === 0}
        onChange={(e) => {
          // The placeholder is `disabled`, so this is belt and braces — but it is
          // the guarantee `onPick` rests on: what comes back is always an option.
          if (e.target.value !== UNSET) onPick(e.target.value);
        }}
      >
        {inForce === null && (
          <option value={UNSET} disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
