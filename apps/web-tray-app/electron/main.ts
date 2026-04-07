import { app, Tray, Menu, shell, nativeImage, dialog } from "electron";
import path from "path";
import { NextServerManager } from "@note/electron-server";

// Minimale 16x16 PNG als fallback tray-icoon
const FALLBACK_ICON_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAIklEQVQ4T2NkoBAwUqifYdSA" +
  "UQNGDRg1YNQAcjUAABiIAAGnkdaVAAAAAElFTkSuQmCC";

// Voorkom meerdere instanties
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

app.on("window-all-closed", () => { /* tray-only: niet afsluiten */ });
if (app.dock) app.dock.hide();

const serverManager = new NextServerManager();
let tray: Tray | null = null;

function buildIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "tray-icon.png")
    : path.join(__dirname, "../public/tray-icon.png");

  const fromFile = nativeImage.createFromPath(iconPath);
  if (!fromFile.isEmpty()) return fromFile.resize({ width: 16, height: 16 });
  return nativeImage
    .createFromDataURL(`data:image/png;base64,${FALLBACK_ICON_BASE64}`)
    .resize({ width: 16, height: 16 });
}

function setTrayMenu(serverUrl: string | null): void {
  if (!tray) return;
  const starting = serverUrl === null;
  tray.setToolTip(starting ? "NoteMarkdown - Opstarten..." : "NoteMarkdown");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: starting ? "Opstarten..." : "Open in browser",
        enabled: !starting,
        click: () => { if (serverUrl) void shell.openExternal(serverUrl); },
      },
      { type: "separator" },
      {
        label: "Afsluiten",
        click: () => { serverManager.stop(); app.quit(); },
      },
    ])
  );
  if (!starting) {
    tray.on("click", () => void shell.openExternal(serverUrl!));
  }
}

app.whenReady().then(async () => {
  // Tray direct zichtbaar maken, ZONDER op de server te wachten
  tray = new Tray(buildIcon());
  setTrayMenu(null);

  try {
    const port = await serverManager.start(app.isPackaged, process.resourcesPath);
    const url = `http://127.0.0.1:${port}`;
    setTrayMenu(url);
    console.log(`NoteMarkdown tray actief — ${url}`);
  } catch (err) {
    console.error("Server starten mislukt:", err);
    dialog.showErrorBox("NoteMarkdown", `Server kon niet starten:\n${err}`);
    app.quit();
  }
});

app.on("before-quit", () => serverManager.stop());
