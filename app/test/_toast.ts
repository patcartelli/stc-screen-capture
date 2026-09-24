import type { ElectronApplication, Page } from "playwright";

/**
 * The main window's message toast (STC-412 Task 7), if one is currently up —
 * undefined otherwise. Replaces every e2e test's old `win.locator("#alert")`
 * read: Task 6 removed the main window's inline `#alert` banner entirely, and
 * a warning now shows in a SEPARATE `BrowserWindow` (`toast-window.ts`'s
 * `showMessageToast`, `mode=message` — the undo toast this app also has is a
 * different mode of the same window and is deliberately not matched here).
 *
 * `app.windows()` is the right instrument for this, not `_windows.ts`'s
 * main-process `getAllWindows()` — a caller needs a real `Page` to read text
 * off, and `panel-waits.e2e.test.ts`'s own `toastWindow` already does exactly
 * this for the undo toast. One owner, so every migrated test finds the toast
 * the same way (this codebase's own "one value, two copies" lesson).
 */
export async function toastPage(app: ElectronApplication): Promise<Page | undefined> {
  return app.windows().find((w) => w.url().includes("toast.html") && w.url().includes("mode=message"));
}

/** The toast's message text, or "" if none is up. */
export async function toastText(app: ElectronApplication): Promise<string> {
  const page = await toastPage(app);
  if (!page) return "";
  return (await page.textContent("#label")) ?? "";
}
