export type ThemeMode = "dark" | "light";

export const THEME_STORAGE_KEY = "xgent-hub:theme:v1";

export function readStoredTheme(defaultTheme: ThemeMode = "light"): ThemeMode {
  if (typeof window === "undefined") return defaultTheme;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : defaultTheme;
  } catch {
    return defaultTheme;
  }
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

export function persistTheme(theme: ThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable in restricted shells.
  }
}
