import { useEffect, useState } from "react";
import { applyTheme, persistTheme, readStoredTheme, type ThemeMode } from "../utils/theme";

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => readStoredTheme("light"));
  useEffect(() => {
    const sync = () => setTheme(readStoredTheme("light"));
    window.addEventListener("xgent:theme-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("xgent:theme-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  useEffect(() => { applyTheme(theme); persistTheme(theme); }, [theme]);
  return [theme, setTheme] as const;
}
