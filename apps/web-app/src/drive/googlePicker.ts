interface PickerFile { id: string; name: string; mimeType: string }
interface PickerView { setIncludeFolders(value: boolean): void; setSelectFolderEnabled(value: boolean): void }
interface PickerData { action: string; docs?: PickerFile[] }
interface PickerBuilder { addView(view: PickerView): PickerBuilder; setOAuthToken(token: string): PickerBuilder; setDeveloperKey(key: string): PickerBuilder; setAppId(id: string): PickerBuilder; setCallback(callback: (data: PickerData) => void): PickerBuilder; build(): { setVisible(value: boolean): void } }
interface PickerApi { Action: { PICKED: string }; ViewId: { FOLDERS: string }; DocsView: new (id: string) => PickerView; PickerBuilder: new () => PickerBuilder }
declare global { interface Window { gapi?: { load(name: string, callback: () => void): void }; google?: { picker: PickerApi } } }

/** Loads the Google Picker browser library once. @returns Nothing when picker APIs are ready. */
async function loadPicker(): Promise<void> { if (window.google?.picker) return; await new Promise<void>((resolve, reject) => { const existing = document.querySelector<HTMLScriptElement>('script[data-notemarkdown-picker]'); const ready = () => window.gapi?.load("picker", resolve); if (existing) { ready(); return; } const script = document.createElement("script"); script.src = "https://apis.google.com/js/api.js"; script.dataset.notemarkdownPicker = "true"; script.onload = ready; script.onerror = () => reject(new Error("Google Picker could not be loaded.")); document.head.append(script); }); }

/** Opens folder-only Google Picker with a memory-only Drive credential. @param accessToken Short-lived token. @returns Selected folder or null. */
export async function pickDriveFolder(accessToken: string): Promise<PickerFile | null> {
  await loadPicker(); const picker = window.google!.picker; const apiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined; const appId = import.meta.env.VITE_GOOGLE_APP_ID as string | undefined;
  if (!apiKey || !appId) throw new Error("Google Picker API key and app ID are not configured.");
  return new Promise((resolve) => { const view = new picker.DocsView(picker.ViewId.FOLDERS); view.setIncludeFolders(true); view.setSelectFolderEnabled(true); const builder = new picker.PickerBuilder(); builder.addView(view).setOAuthToken(accessToken).setDeveloperKey(apiKey).setAppId(appId).setCallback((data) => { if (data.action === picker.Action.PICKED) resolve(data.docs?.[0] ?? null); }).build().setVisible(true); });
}

/** Creates a folder directly in Drive using the selected connected account. @param accessToken Short-lived token. @param name Folder display name. @returns Created folder metadata. */
export async function createDriveFolder(accessToken: string, name: string): Promise<PickerFile> { const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType", { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) }); if (!response.ok) throw new Error("The Drive folder could not be created."); return response.json() as Promise<PickerFile>; }
