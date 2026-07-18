/**
 * Theme handling: honors prefers-color-scheme by default; a manual toggle
 * (top-bar sun/moon button) pins an explicit choice in localStorage.
 */

import { clearPref, readPref, writePref } from "./prefs";

export type Theme = "light" | "dark";

const media = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

export function systemTheme(): Theme {
  return media().matches ? "dark" : "light";
}

export function currentTheme(): Theme {
  const pinned = readPref<Theme | null>("theme", null);
  return pinned ?? systemTheme();
}

function apply(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}

/** Apply the initial theme and follow OS changes while not pinned. */
export function initTheme(onChange: (theme: Theme) => void): void {
  apply(currentTheme());
  onChange(currentTheme());
  media().addEventListener("change", () => {
    if (readPref<Theme | null>("theme", null) === null) {
      apply(systemTheme());
      onChange(systemTheme());
    }
  });
}

/** Manual toggle: pins the opposite of the current effective theme. If that
 * happens to match the OS preference again, unpin (back to following the OS). */
export function toggleTheme(onChange: (theme: Theme) => void): void {
  const next: Theme = currentTheme() === "dark" ? "light" : "dark";
  if (next === systemTheme()) {
    clearPref("theme");
  } else {
    writePref("theme", next);
  }
  apply(next);
  onChange(next);
}
