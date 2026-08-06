import { editorCommands, findKeybindingConflicts, type EditorCommandId } from "@note/editor";
import type { AppSettings, ThemeMode } from "../state/settings";
import type { Locale } from "../i18n";
import { translate } from "../i18n";
import styles from "./MilestonePanels.module.css";

interface SettingsDialogProps {
  locale: Locale;
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
}

/**
 * Renders global local-first settings without workspace-specific overrides.
 * @param props Current settings and update callbacks.
 * @returns Accessible settings dialog.
 */
export function SettingsDialog({ locale, settings, onChange, onClose }: SettingsDialogProps) {
  const conflicts = findKeybindingConflicts(settings.keybindings);

  /** Updates one command's comma-separated key chords. @param commandId Stable editor command. @param value User-entered bindings. @returns Nothing. */
  const updateBinding = (commandId: EditorCommandId, value: string): void => {
    const bindings = value.split(",").map((binding) => binding.trim()).filter(Boolean);
    onChange({ ...settings, keybindings: { ...settings.keybindings, [commandId]: bindings } });
  };

  return (
    <div className={styles.dialogBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><h2 id="settings-title">{translate(locale, "settings")}</h2><button type="button" onClick={onClose} aria-label={translate(locale, "closeDialog")}>×</button></header>
        <label>
          <span>{translate(locale, "theme")}</span>
          <select value={settings.theme} onChange={(event) => onChange({ ...settings, theme: event.target.value as ThemeMode })}>
            <option value="system">{translate(locale, "themeSystem")}</option>
            <option value="light">{translate(locale, "themeLight")}</option>
            <option value="dark">{translate(locale, "themeDark")}</option>
          </select>
        </label>
        <label className={styles.check}><input type="checkbox" checked={settings.spellCheck} onChange={(event) => onChange({ ...settings, spellCheck: event.target.checked })} /><span>{translate(locale, "spelling")}</span></label>
        <label><span>{translate(locale, "assetDirectory")}</span><input value={settings.assetDirectory} onChange={(event) => onChange({ ...settings, assetDirectory: event.target.value })} /></label>
        <fieldset className={styles.keybindings}>
          <legend>{translate(locale, "keybindings")}</legend>
          {editorCommands.map((command) => <label key={command.id}><span>{command.label}</span><input value={(settings.keybindings[command.id] ?? command.defaultBindings).join(", ")} onChange={(event) => updateBinding(command.id, event.target.value)} /></label>)}
          {conflicts.length ? <p role="alert">{translate(locale, "keybindingConflict")}: {conflicts.map((conflict) => conflict.binding).join(", ")}</p> : null}
        </fieldset>
      </section>
    </div>
  );
}
