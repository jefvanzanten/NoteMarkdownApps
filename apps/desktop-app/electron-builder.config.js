/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.note.desktop-app",
  productName: "NoteMarkdown",
  directories: {
    output: "release",
  },
  files: [
    "dist/**/*",
    // Kopieert de Next.js standalone build uit web-tray-app
    {
      from: "../web-tray-app/.next/standalone",
      to: "nextjs-server",
      filter: ["**/*"],
    },
    {
      from: "../web-tray-app/.next/static",
      to: "nextjs-server/.next/static",
      filter: ["**/*"],
    },
    {
      from: "../web-tray-app/public",
      to: "nextjs-server/public",
      filter: ["**/*"],
    },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
};
