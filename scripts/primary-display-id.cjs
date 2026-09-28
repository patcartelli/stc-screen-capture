// Electron main script: print the PRIMARY display's id and quit (STC-464).
// Run by vitest.global-setup.ts, which hands the id to the helper stand-in —
// see app/test/_fake-displays.mjs for why the stand-in needs the real one.
const { app, screen } = require("electron");

app.dock?.hide();
app.whenReady().then(() => {
  process.stdout.write(String(screen.getPrimaryDisplay().id));
  app.exit(0);
});
