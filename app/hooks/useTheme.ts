"use client";

/**
 * Theme selection.
 *
 * Three states, like Excalidraw: light, dark, or follow the system. The resolved
 * theme is written to `data-theme` on the document element, which is what the CSS
 * tokens key off, so no component needs to know which theme is active.
 */
import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "collabdraw_theme";

const readPreference = (): ThemePreference => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "system";
  } catch {
    return "system";
  }
};

const systemTheme = (): ResolvedTheme =>
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

export interface ThemeState {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Cycles light -> dark -> system, for a single toggle button. */
  cycle: () => void;
}

export const useTheme = (): ThemeState => {
  // Server-render as light; the effect below corrects it before paint.
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [systemPreference, setSystemPreference] =
    useState<ResolvedTheme>("light");

  useEffect(() => {
    setPreferenceState(readPreference());
    setSystemPreference(systemTheme());

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemPreference(systemTheme());

    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const theme: ResolvedTheme =
    preference === "system" ? systemPreference : preference;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Lets the browser theme form controls and scrollbars to match.
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A blocked storage just means the choice does not outlive the session.
    }
  }, []);

  const cycle = useCallback(() => {
    setPreference(
      preference === "light" ? "dark" : preference === "dark" ? "system" : "light",
    );
  }, [preference, setPreference]);

  return { preference, theme, setPreference, cycle };
};
