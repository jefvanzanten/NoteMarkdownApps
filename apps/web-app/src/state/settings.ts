import type { EditorKeybindings } from "@note/editor";
import type { Locale } from "../i18n";

export type ThemeMode = "light" | "dark" | "system";

export interface AppSettings {
  theme: ThemeMode;
  locale: Locale;
  spellCheck: boolean;
  assetDirectory: string;
  keybindings: EditorKeybindings;
  updatedAt: number;
}

const SETTINGS_KEY = "notemarkdown:settings:v1";

/**
 * Reads validated anonymous global settings from local storage.
 * @returns Current settings with safe defaults.
 */
export function loadSettings(): AppSettings {
  const detectedLocale: Locale = navigator.language.toLowerCase().startsWith("nl") ? "nl" : "en";
  const defaults: AppSettings = { theme: "system", locale: detectedLocale, spellCheck: true, assetDirectory: "assets", keybindings: {}, updatedAt: 0 };
  try {
    const value = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<AppSettings>;
    return {
      theme: value.theme === "light" || value.theme === "dark" || value.theme === "system" ? value.theme : defaults.theme,
      locale: value.locale === "nl" || value.locale === "en" ? value.locale : defaults.locale,
      spellCheck: typeof value.spellCheck === "boolean" ? value.spellCheck : defaults.spellCheck,
      assetDirectory: typeof value.assetDirectory === "string" && /^[^./][^\\]*$/.test(value.assetDirectory) ? value.assetDirectory : defaults.assetDirectory,
      keybindings: value.keybindings && typeof value.keybindings === "object" ? value.keybindings : defaults.keybindings,
      updatedAt: typeof value.updatedAt === "number" && value.updatedAt >= 0 ? value.updatedAt : defaults.updatedAt,
    };
  } catch {
    return defaults;
  }
}

/**
 * Persists and applies global anonymous settings.
 * @param settings Complete settings snapshot.
 * @returns Nothing after browser preferences are updated.
 */
export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  document.documentElement.lang = settings.locale;
  if (settings.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}

/**
 * Applies persisted settings before the first interactive render.
 * @returns The applied settings snapshot.
 */
export function initializeSettings(): AppSettings {
  const settings = loadSettings();
  saveSettings(settings);
  return settings;
}
