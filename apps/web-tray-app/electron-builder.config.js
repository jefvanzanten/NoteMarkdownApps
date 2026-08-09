/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: "com.note.web-tray-app",
  productName: "NoteMarkdown Tray",
  directories: {
    output: "release",
  },
  files: [
    "dist-electron/**/*",
    {
      from: ".next/standalone",
      to: "nextjs-server",
      filter: ["**/*"],
    },
    {
      from: ".next/static",
      to: "nextjs-server/.next/static",
      filter: ["**/*"],
    },
    {
      from: "public",
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
