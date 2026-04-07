import { app, BrowserWindow, Menu, shell } from "electron";
import { NextServerManager } from "@note/electron-server";

const serverManager = new NextServerManager();
let mainWindow: BrowserWindow | null = null;

function createWindow(serverUrl: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "NoteMarkdown",
    backgroundColor: "#0f172a",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.loadURL(serverUrl);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Open externe links in de standaard browser, niet in het app-venster
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith("http://127.0.0.1")) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu(serverUrl: string): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Bestand",
      submenu: [
        {
          label: "Open in browser",
          click: () => void shell.openExternal(serverUrl),
        },
        { type: "separator" },
        { label: "Afsluiten", role: "quit" },
      ],
    },
    { label: "Bewerken", role: "editMenu" },
    { label: "Weergave", role: "viewMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    const port = await serverManager.start(app.isPackaged, app.isPackaged ? process.resourcesPath : "");
    const url = `http://127.0.0.1:${port}`;
    buildMenu(url);
    createWindow(url);
  } catch (err) {
    console.error("Server starten mislukt:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    serverManager.stop();
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    serverManager
      .start(app.isPackaged, app.isPackaged ? process.resourcesPath : "")
      .then((port) => createWindow(`http://127.0.0.1:${port}`))
      .catch(console.error);
  }
});

app.on("before-quit", () => {
  serverManager.stop();
});
