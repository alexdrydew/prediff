/**
 * View-preference persistence (localStorage). Deliberately limited to view
 * prefs — comment data lives server-side, never here (spec §4.2, §9.1).
 */

const PREFIX = "prediff.";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode etc.) — prefs just don't persist
  }
}

export function clearPref(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}
