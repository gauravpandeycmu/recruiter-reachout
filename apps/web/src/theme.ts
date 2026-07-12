/** Site appearance: light or dark only. */

export const THEME_PREF_KEY = "recruiter-reachout-theme";
export const THEME_CHANGED_EVENT = "grove-theme";

export type ThemePreference = "light" | "dark";

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_PREF_KEY);
    if (stored === "light" || stored === "dark") return stored;
    // Migrate legacy "system" (and anything unknown) to a concrete mode once.
    if (stored === "system") {
      const resolved = systemPrefersDark() ? "dark" : "light";
      localStorage.setItem(THEME_PREF_KEY, resolved);
      return resolved;
    }
  } catch {
    // fall through
  }
  return "light";
}

/** Apply theme to <html> — call before paint when possible. */
export function applyTheme(pref: ThemePreference = readThemePreference()): ThemePreference {
  const root = document.documentElement;
  root.dataset.theme = pref;
  root.style.colorScheme = pref;
  return pref;
}

export function writeThemePreference(pref: ThemePreference): ThemePreference {
  try {
    localStorage.setItem(THEME_PREF_KEY, pref);
  } catch {
    // ignore storage failures
  }
  const resolved = applyTheme(pref);
  try {
    window.dispatchEvent(
      new CustomEvent(THEME_CHANGED_EVENT, { detail: { preference: pref, resolved } }),
    );
  } catch {
    // ignore
  }
  return resolved;
}

/** Flip light ↔ dark. */
export function toggleThemePreference(current: ThemePreference = readThemePreference()): ThemePreference {
  const next: ThemePreference = current === "dark" ? "light" : "dark";
  writeThemePreference(next);
  return next;
}
