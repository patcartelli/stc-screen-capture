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

/**
 * The toast's message text, or "" if none is up — title (when there is one)
 * and body, joined by a newline, the same string `toast-message.ts`'s
 * `toastMessageText` builds. STC-457 gave the toast a separate `#title`; a
 * test that asks "what did it say" means both.
 */
export async function toastText(app: ElectronApplication): Promise<string> {
  const page = await toastPage(app);
  if (!page) return "";
  // The window is listed by url as soon as it commits navigation, which can
  // be before its DOM exists — an absent element is "nothing said yet", never
  // a throw, so a poll on this keeps polling rather than failing on its first
  // early read.
  return page.evaluate(() => {
    const head = document.getElementById("head");
    const label = document.getElementById("label");
    // `toast-renderer.ts` stamps `data-mode` in the same synchronous run that
    // fills the label. Until then `#label` still holds the HTML's own
    // placeholder ("Deleted", the undo toast's word), which is not anything
    // the app said.
    if (!head || !label || document.documentElement.dataset.mode !== "message") return "";
    const title = head.classList.contains("has-title")
      ? document.getElementById("title")?.textContent ?? "" : "";
    const body = label.textContent ?? "";
    return title ? `${title}\n${body}` : body;
  }).catch(() => "");
}
