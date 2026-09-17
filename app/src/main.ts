import {
  app, BrowserWindow, ipcMain, dialog, shell, globalShortcut, screen, Menu, nativeImage,
  powerMonitor, type IpcMainInvokeEvent,
} from "electron";
import { readSettings, writeSettings, type Settings } from "./settings.js";
import {
  SHOT_ACTIONS, DEFAULT_SHORTCUTS, planShortcuts,
  type ShotAction, type ShortcutReport, type Shortcuts,
} from "./hotkeys.js";
import { installTray, type TrayHandle } from "./tray.js";
import {
  buildThumbMenu, type ThumbMenuContext, type ThumbMenuId,
} from "./thumbnail-menu.js";
import { playShutter } from "./shutter.js";
import {
  CLIPBOARD_SUBDIR, exportStill, plannedFileName, resolveExportOptions,
  type CompositedStill, type ExportTarget,
} from "./still-io.js";
import { colorSpaceFor, type ExportOptions } from "@transform/still-export.js";
import { parseShot, shotForWrite } from "@transform/shot.js";
import { isProjectVersion } from "@transform/project-version.js";
import {
  DEFAULT_EMBED_TEMPLATE, embedSnippet, exportManifestName, exportMediaName, planPublish,
  publicSrc, type PublishPlan,
} from "./share.js";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { readFile, writeFile, stat, open, copyFile, rm, mkdir } from "node:fs/promises";
import { HelperSupervisor } from "./supervisor.js";
import type { HelperLine } from "./helper-client.js";
import { newTakeDir, takesRoot, setTakeLabel, insideTakesRoot, duplicateTake } from "./takes.js";
import {
  tempTakesRoot, newTempTakeDir, insideTempTakesRoot, promoteTake,
  purgeStaleTempTakes, listTempTakes, migrateLegacyTempTakes,
} from "./temp-takes.js";
import { listTakes, listLibrary, THUMBNAIL_FILE } from "./library.js";
import { PRODUCT_NAME, LEGACY_APP_DIR_NAME, productStamp } from "./product.js";
import { openOverlay, closeOverlay, overlayIsOpen } from "./overlay-session.js";
import { flashScopeIndicator, hideScopeIndicator } from "./scope-indicator-window.js";
import { cancelCountdown, countdownIsOpen, runCountdown } from "./countdown-window.js";
import { clampCountdownMs, countdownFired, needsCountdown } from "./countdown.js";
import type { WindowInfo } from "./selection.js";
import {
  presentThumbnail, beforeCapture as hideThumbnailForCapture,
  afterCapture as showThumbnailsAfterCapture, closeThumbnail, dismissThumbnail,
  unsavedTakeDirs,
} from "./thumbnail-window.js";
import { promotes, trashStyle } from "./panel-actions.js";
import { quitDecision } from "./quit-guard.js";
import { openEditor } from "./editor-window.js";
import { attachPillToSupervisor } from "./pill-window.js";
import { MIN_PILL_WIDTH_PX } from "./pill.js";
import { PendingTrash } from "./pending-trash.js";
import { showUndoToast, hideUndoToast } from "./toast-window.js";

/**
 * Electron main process. Owns the helper: it is spawned as a CHILD of this
 * process, which is what gives it this app's TCC identity — one grant, against
 * the signed bundle the user recognises, rather than a second opaque helper
 * appearing in System Settings (PHASE-0 §6, demonstrated in increment 2).
 */

const here = dirname(fileURLToPath(import.meta.url));
/**
 * Overridable for the same reason STC_RECORDINGS_DIR is: the E2E suite needs to
 * drive the real start path against a stand-in, because the real helper cannot
 * record without a Screen Recording grant and CI has no way to give one. Also
 * useful for pointing the app at a debug build.
 */
const HELPER = process.env.STC_HELPER_BIN
  || join(here, "..", "..", "helper", "build", "stc-helper");

let win: BrowserWindow | undefined;
let sup: HelperSupervisor | undefined;
/**
 * STC-375: the pill's real, renderer-measured content width — reported by
 * `#pill`'s ResizeObserver (renderer.ts) over `pill:contentWidth`, fire-
 * and-forget. `getContentWidthPx` below reads this SYNCHRONOUSLY when a
 * heartbeat triggers a collapse; IPC has no synchronous request the other
 * direction, so a cache kept current by the renderer's own pushes is the
 * only way main can have a real number ready at the moment it needs one.
 * Starts at the floor, matching what the window collapses to before the
 * page has ever measured anything.
 */
let pillContentWidthPx = MIN_PILL_WIDTH_PX;
ipcMain.on("pill:contentWidth", (_e, px: unknown) => {
  if (typeof px === "number" && Number.isFinite(px) && px > 0) pillContentWidthPx = px;
});
/**
 * The take each WINDOW may currently read, set only by preview:open.
 *
 * Keyed by `sender.id` rather than a single variable (STC-373): with the
 * editor as its own window, the main window's library and the editor can
 * both be alive at once, and a single `openTake` would let either one clobber
 * the other's idea of what is open. Entries are removed when their sender is
 * destroyed, so a closed window cannot leave a stale entry for a later
 * `webContents.id` to inherit.
 */
const openTakes = new Map<number, string>();
const cleanedUpSenders = new WeakSet<Electron.WebContents>();

function getOpenTake(e: IpcMainInvokeEvent): string | undefined {
  return openTakes.get(e.sender.id);
}

function setOpenTake(e: IpcMainInvokeEvent, dir: string): void {
  openTakes.set(e.sender.id, dir);
  if (!cleanedUpSenders.has(e.sender)) {
    cleanedUpSenders.add(e.sender);
    e.sender.once("destroyed", () => openTakes.delete(e.sender.id));
  }
}

function clearOpenTake(e: IpcMainInvokeEvent): void {
  openTakes.delete(e.sender.id);
}

let tray: TrayHandle | undefined;
let shortcuts: Shortcuts = { ...DEFAULT_SHORTCUTS };
let shortcutReport: ShortcutReport[] = [];
/**
 * A capture is in flight. Not derived from `overlayIsOpen()`: a full-display
 * shot opens no overlay, and the window between the request and the helper's
 * reply is exactly when a second hotkey press would arrive.
 */
let capturing = false;
/**
 * The last still THIS process wrote, for `still:reveal` (STC-293).
 *
 * Remembered here rather than passed back through the renderer because a
 * destination folder is by definition outside the recordings root, so
 * `recorder:reveal`'s "inside the recordings folder" guard correctly refuses
 * it — and widening that guard to accept a renderer-supplied path would hand
 * the sandboxed renderer the ability to open anything. A path the main process
 * produced itself needs no guard at all.
 */
let lastStillFile: string | undefined;

/**
 * Inside the library root OR the temp root (STC-393).
 *
 * An unsaved capture's own panel still needs to read its frame, redact it,
 * reveal it or discard it while it sits in temp — `insideTakesRoot` alone
 * would refuse all of that the moment captures stopped landing in the
 * library immediately. Handlers that only ever operate on an ALREADY-saved
 * take (the library grid, the editor, duplicate) keep using
 * `insideTakesRoot` unwidened: a temp take has no business reaching them.
 */
function insideCaptureRoot(env: NodeJS.ProcessEnv, dir: string): boolean {
  return insideTakesRoot(env, dir) || insideTempTakesRoot(env, dir);
}

/**
 * Deletions the ✕ has promised but not yet committed (STC-392 Task 6). One
 * instance for the whole process, the same reason `openTakes` and `tray`
 * above are module-level rather than per-window — a promised deletion
 * outlives the panel it was pressed from.
 */
const pendingTrash = new PendingTrash();

/** How often to check for a promise whose undo window has elapsed. Small
 * enough that the toast's own bar (driven by the identical `UNDO_WINDOW_MS`)
 * and the moment the file actually moves cannot drift far apart. */
const TRASH_SWEEP_INTERVAL_MS = 1_000;

// The renderer is sandboxed and cannot read files. It gets bytes over IPC and
// never names a path: it may ask for one of a few fixed filenames, and only
// from the take the main process deliberately opened.
//
// A custom protocol was the first attempt and cannot work here — the window is
// loaded from file://, and Chromium refuses cross-origin fetches from a file
// origin to any non-http scheme. Serving the app itself over a custom scheme
// would fix that, but IPC removes the origin question altogether.
const TAKE_FILES = new Set(["anchors.json", "events.json", "display.mp4", "camera.mp4", "mic.m4a", "project.json"]);

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow(): void {
  setDockVisible(true);
  win = new BrowserWindow({
    width: 520, height: 680, title: PRODUCT_NAME,
    // STC-375 (Pill): a fully frameless window was the other option on the
    // table and was passed over — see pill.ts's header. "hidden" keeps the
    // native traffic lights as an inset overlay (no drawn title strip), which
    // is what lets Record collapse the window to a 26px pill at all.
    titleBarStyle: "hidden",
    webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(join(here, "..", "renderer", "index.html"));
  // STC-375: collapse/restore is driven by the supervisor's own confirmed
  // state (traps 1 and 3 in pill.ts's header), never by the Record click.
  // Re-attached on every createWindow() call, since STC-292 made the main
  // window closable and re-creatable (menu-bar-first) and a stale listener on
  // a destroyed window is not a live one.
  if (sup) {
    const detachPill = attachPillToSupervisor(win, sup, {
      getContentWidthPx: () => pillContentWidthPx,
    });
    win.once("closed", detachPill);
  }
}

/**
 * Menu-bar first (STC-292): no Dock icon while no window is open.
 *
 * The whole point of the hotkey and the menu-bar item is that a capture never
 * needs the app brought forward, and an app that keeps a bouncing Dock icon
 * for a window nobody has open contradicts that every time the user looks at
 * the Dock. The icon comes back the moment there IS a window, because a window
 * with no Dock icon cannot be found again after it is hidden behind something.
 *
 * The cost is stated rather than hidden: with the icon gone, `app.on("activate")`
 * can no longer fire, so the menu bar is the only way back in. That is why
 * `installTray` runs before the first window and why its Quit item is not
 * optional.
 */
function setDockVisible(visible: boolean): void {
  if (process.platform !== "darwin") return;
  try {
    if (visible) void app.dock?.show();
    else app.dock?.hide();
  } catch {
    /* an activation-policy change is never worth a crash */
  }
}

/** The way back to a window from the menu bar. */
function openLibrary(): void {
  setDockVisible(true);
  if (!win || win.isDestroyed()) createWindow();
  else { win.show(); win.focus(); }
  // Without this an accessory app raises the window behind whatever is
  // frontmost, which reads as the click having done nothing.
  app.focus({ steal: true });
}

function startSupervisor(): void {
  sup = HelperSupervisor.start(HELPER, { statsIntervalMs: 500 });
  sup.on("ready", (l) => send("helper:ready", l));
  sup.on("stats", (l) => send("helper:stats", l));
  sup.on("respawned", (i) => send("helper:respawned", i));
  sup.on("gave-up", (i) => send("helper:gave-up", i));
  // The helper holds the capture devices: if it dies mid-recording the take is
  // gone, and that must be stated rather than left to look like an idle reset.
  sup.on("recording-lost", (i) => send("helper:recording-lost", i));
  // Stopped cleanly without being asked — the take is intact, unlike a loss.
  // Already promoted out of temp storage by the time this fires (STC-393):
  // `HelperSupervisor.endRecording` does that before emitting, so a grid
  // refresh triggered by this event finds the take where it now lives.
  sup.on("recording-ended", (i) => send("helper:recording-ended", i));
  // A promotion that failed (STC-393) — the take is still a real recording,
  // just stuck in temp storage rather than the library. Surfaced as a
  // warning rather than folded into `recording-lost`: the file is intact,
  // unlike a genuine loss, and crash recovery will pick it up on next launch
  // if nothing here gets to it first.
  sup.on("recording-promote-failed", (i) => send("helper:warning", {
    code: "recording-not-promoted",
    detail: `Recording saved but could not be moved into the library: ${i?.dir}`,
  }));
  sup.on("helper:warning", (l) => send("helper:warning", l));
  // STC-287. The camera opens off the critical path (deliberately — see
  // Capture.swift), so it goes live a second or so AFTER recording starts. The
  // helper has always announced that; nothing was listening, so the user's only
  // evidence the camera worked was a PiP appearing ~1.4 s into playback, which
  // reads as a glitch rather than as the camera starting.
  sup.on("helper:camera-started", (l) => send("helper:camera-started", l));
  // STC-233: same reasoning, one device over — the mic also opens off the
  // critical path (MicCapture.swift) and reports separately once it resolves.
  sup.on("helper:mic-started", (l) => send("helper:mic-started", l));
}

/**
 * Purge, then — whatever survives that — offer to recover it (STC-393).
 *
 * Order matters: a temp take that is only stale gets silently deleted by the
 * purge and must never reach the prompt, or "N unsaved takes recovered"
 * would include things the app itself just decided to throw away.
 *
 * Nothing can be "claimed" yet at the point this runs — no capture has
 * started this session — so every survivor is, by definition, something a
 * PREVIOUS run left behind with no panel and no clean stop to claim it.
 */
async function recoverUnsavedTakes(): Promise<void> {
  await purgeStaleTempTakes(process.env).catch((e) => {
    console.error("[temp-takes] purge failed:", e);
    return [];
  });
  const orphaned = await listTempTakes(process.env).catch((e) => {
    console.error("[temp-takes] could not list temp storage:", e);
    return [];
  });
  if (orphaned.length === 0) return;

  const { response } = await dialog.showMessageBox({
    type: "info",
    buttons: ["Review", "Discard all"],
    defaultId: 0,
    cancelId: 0,
    message: orphaned.length === 1 ? "1 unsaved take recovered" : `${orphaned.length} unsaved takes recovered`,
    detail: "The app didn't shut down cleanly last time — these takes never made it to your library.",
  });

  if (response === 1) {
    for (const t of orphaned) await rm(t.dir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  // Oldest first: `presentThumbnail` always unshifts its newest call to the
  // front of the stack, so presenting in this order leaves the genuinely
  // most-recent recovered take frontmost — matching the ticket's "most
  // recent first, and focuses it" (STC-392 focus rule 1 does the actual
  // focusing now; see thumbnail-window.ts).
  const ordered = [...orphaned].reverse();
  const { thumbnail } = readSettings(app.getPath("userData"));
  for (const t of ordered) {
    if (t.kind === "still") {
      try {
        const shot = JSON.parse(await readFile(join(t.dir, "shot.json"), "utf8"));
        presentThumbnail({
          dir: t.dir, shot, corner: thumbnail.corner,
          // A recovered temp take has never been decided on — nobody has
          // said yes to it, the same as an ordinary fresh capture.
          take: { kind: "shot", origin: "fresh" },
          dist: here, rendererDir: join(here, "..", "renderer"),
        });
      } catch (e) {
        console.error("[recovery] could not reopen a recovered still:", t.dir, e);
      }
    } else if (t.kind === "recording") {
      // No STC-392 panel exists yet for a recording, so there is nothing to
      // "bring back" — the closest honest equivalent is to save it outright
      // (rather than let it expire silently in 7 days) and bring the library
      // where it now lives in front of the user.
      try {
        await promoteTake(process.env, t.dir);
        openLibrary();
      } catch (e) {
        console.error("[recovery] could not move a recovered recording into the library:", t.dir, e);
      }
    } else {
      console.error("[recovery] unrecognised temp take, leaving it in place:", t.dir);
    }
  }
}

/** How often to sweep temp storage for stale takes while the app keeps running. */
const TEMP_PURGE_INTERVAL_MS = 12 * 60 * 60 * 1000;

// STC-399: the editor's export dialog has no other way to reach
// `app.getVersion()` — it is a renderer, sandboxed like every other window.
ipcMain.handle("app:version", () => app.getVersion());

/**
 * Carry `settings.json` across the rename to Capture (STC-397).
 *
 * `productName` sets `app.getName()`, which sets `app.getPath("userData")` —
 * so renaming the product moves that folder from `…/stc-screen-recorder` to
 * `…/Capture`, and a user's camera choice, mic, four custom hotkeys, still
 * destination and share destination are orphaned: still on disk, in a folder
 * the app no longer reads.
 *
 * `settings.json` is the ONLY file this app writes there — everything else
 * in that directory is Chromium's (caches, GPUCache, Local State) and
 * regenerates on demand — so this copies that one file rather than dragging
 * a stale browser cache into the new folder under a new name.
 *
 * The legacy directory is resolved as a SIBLING of the current one rather
 * than rebuilt from `homedir()` + a hardcoded `Library/Application Support`:
 * Electron already knows where user data lives on this platform, and
 * spelling that path a second time here is how the migration silently
 * stops finding anything the first time it runs somewhere unexpected.
 *
 * Runs on EVERY launch and must therefore be idempotent: it does nothing
 * once the new file exists, so a settings change made after the rename is
 * never overwritten by the pre-rename copy.
 */
function migrateLegacyAppData(): void {
  const current = app.getPath("userData");
  const legacy = join(dirname(current), LEGACY_APP_DIR_NAME);
  if (legacy === current) return;
  const from = join(legacy, "settings.json");
  const to = join(current, "settings.json");
  if (!existsSync(from) || existsSync(to)) return;
  try {
    mkdirSync(current, { recursive: true });
    copyFileSync(from, to);
    // COPIED, not moved: if this build is rolled back, the old app finds its
    // settings exactly where it left them. The cost is one stale file in a
    // folder nothing else writes to, which is cheaper than the alternative.
    console.log(`[rename] carried settings.json across from ${legacy}`);
  } catch (e) {
    console.error("[rename] could not carry settings.json across:", e);
  }
}

/**
 * Set once, if ever, by `powerMonitor`'s own `shutdown` event — see the
 * long comment at `quitDecision`'s call site in `before-quit` for what this
 * is and is not known to do on this machine.
 */
let systemShuttingDown = false;

app.whenReady().then(async () => {
  // Subscribed before anything else touches quit machinery, so there is no
  // window during startup where a shutdown notification could arrive and be
  // missed. See the comment at `quitDecision`'s call site for the whole
  // story; this line by itself proves only that the module is reachable.
  powerMonitor.on("shutdown", () => { systemShuttingDown = true; });

  // FIRST, before anything reads settings or looks for unsaved takes — both
  // of those resolve paths that this rename moved (STC-397).
  migrateLegacyAppData();
  await migrateLegacyTempTakes(process.env)
    .then((n) => { if (n) console.log(`[rename] carried ${n} unsaved take(s) across`); })
    .catch((e) => { console.error("[rename] could not carry unsaved takes across:", e); });

  // STC-399: the model code's identity on the one surface Electron owns
  // outright — no custom Menu is ever built here, so this app keeps the
  // platform's default menu, which already has an "About" item; this only
  // customises what it shows. `app.getVersion()` reads package.json's own
  // "version" the same way `app.getPath("userData")` already reads its
  // "name" — the ONE place either is typed.
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: productStamp(app.getVersion()),
  });
  // Ensured once, here, rather than by every capture: the leaf take directory
  // is the helper's to create, but the temp root itself (several levels deep
  // under Application Support) is this app's.
  await mkdir(tempTakesRoot(process.env), { recursive: true }).catch((e) => {
    console.error("[temp-takes] could not create the temp root:", e);
  });
  setInterval(() => { void purgeStaleTempTakes(process.env).catch(() => {}); }, TEMP_PURGE_INTERVAL_MS);
  // Keeps every promise `panel:trash` makes (STC-392 Task 6): whatever
  // `pendingTrash.due()` hands back has had its whole undo window elapse, so
  // it is committed to the real Trash here rather than on any UI timer.
  setInterval(() => {
    for (const dir of pendingTrash.due()) {
      shell.trashItem(dir).catch((e) => {
        console.error("[trash] could not commit a promised deletion:", dir, e);
      });
    }
  }, TRASH_SWEEP_INTERVAL_MS);

  startSupervisor();
  shortcuts = readSettings(app.getPath("userData")).shortcuts;
  // The menu bar first, and deliberately: from here on the app is allowed to
  // have no window, and installing the item afterwards would leave a gap in
  // which a user who closed the window had no way back.
  tray = installTray({ shortcuts, busy: capturing }, (id) => {
    if (id === "library") return openLibrary();
    if (id === "quit") return app.quit();
    const action = SHOT_ACTIONS.find((a) => id === `capture:${a}`);
    if (action) void captureStill(action, "menu-bar");
  });
  applyShortcuts(shortcuts);
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  // Fire-and-forget: a window already exists for "Review" to bring forward,
  // and nothing else in startup depends on this finishing first.
  void recoverUnsavedTakes();
});

app.on("window-all-closed", async () => {
  // A take in flight when its window goes is ENDED, not abandoned: the helper
  // would otherwise keep recording with nothing left that could stop it.
  // `stopRecording` promotes it out of temp storage on its own (STC-393).
  if (sup?.state === "recording") await sup.stopRecording().catch(() => {});
  // On macOS the app stays alive and the helper stays with it. Shutting the
  // helper down here left a reopened window (Dock click) with a supervisor
  // that was "stopped" for good — every Record failed with "helper already
  // exited" until the app was relaunched. Elsewhere, quitting shuts it down.
  if (process.platform !== "darwin") { app.quit(); return; }
  // Nothing on screen: the app is now only its menu-bar item and its hotkeys,
  // which is the state the ticket's acceptance criterion describes.
  setDockVisible(false);
});

// Devices are released on a deliberate quit, not left to process teardown —
// and a recording in flight is stopped first (see HelperSupervisor.shutdown).
// Electron does not await an async listener here, so the first pass holds
// the quit until the shutdown has actually finished, then re-issues it.
let quitting = false;

/**
 * The teardown every quit eventually runs, whichever path decided to allow
 * it — a plain quit with nothing unsaved, "Quit Anyway", or "Save All" once
 * the promotions it does are finished.
 *
 * An overlay still up at quit would outlive its window list and sit on the
 * screen with nothing left to answer it. A thumbnail still up is closed
 * WITHOUT exporting or deleting anything (STC-392 D7) — its take is left
 * exactly where it is (in the library if `before-quit` already promoted it
 * for Save All, in temp storage otherwise), where STC-393's recovery prompt
 * offers a temp one back on the next launch. Nothing here ever deletes a
 * take (ruling 3) — `closeThumbnail`'s own doc comment says the same of the
 * windows it destroys.
 *
 * The one EXCEPTION to "nothing here deletes a take" is a promise `panel:trash`
 * already made (STC-392 Task 6, `pending-trash.ts`): quitting KEEPS it rather
 * than losing it, because a promised deletion left sitting in temp storage
 * would be found by STC-393's recovery prompt on the next launch and offered
 * back as an "unsaved take" — the app handing someone a thing they deliberately
 * deleted. That commit runs BEFORE `closeThumbnail()`, not after: a toast's
 * Undo racing the quit calls `presentThumbnail` again (see `panel:undoTrash`),
 * and ordering it first means that re-presented panel is still in the list
 * `closeThumbnail()` reads and tears down, rather than appearing after that
 * step has already run and outliving it.
 */
function runQuitTeardown(): void {
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = undefined;
  hideScopeIndicator();
  // A countdown at quit answers its caller `cancelled`, so the capture or the
  // recording it was counting down to never happens — which is the only safe
  // answer when the process is going away underneath it.
  cancelCountdown();
  hideUndoToast();
  Promise.all(pendingTrash.all().map((d) =>
    shell.trashItem(d).catch((e) => console.error("[trash] could not commit:", d, e))))
    .then(() => closeThumbnail())
    .catch(() => {})
    .then(() => closeOverlay())
    .catch(() => {})
    .then(() => (sup ? sup.shutdown() : Promise.resolve()))
    .catch(() => {})
    .finally(() => app.quit());
}

app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();

  // A take `panel:trash` has PROMISED to delete (Task 6) is not counted here,
  // and needs no extra check to arrange that: `panel:trash` dismisses the
  // panel the instant it promises the deletion (see that handler), and
  // `unsavedTakeDirs()` only ever counts takes with an OPEN panel — so a
  // pending-trash take has already left this list by the time this line
  // runs. The user already decided its fate; counting it would inflate the
  // warning ("3 takes aren't saved" when one is being deleted on purpose) and
  // "Save All" would promote it into the library, resurrecting the very take
  // the ✕ was pressed on.
  const unhandled = unsavedTakeDirs().length;
  /**
   * STC-392 D8 — telling a user-initiated ⌘Q apart from a logout, restart or
   * shutdown so the warning below can skip the second case (see
   * `quit-guard.ts`'s module doc for WHY it must skip it, not just that it
   * does).
   *
   * WHAT WAS ACTUALLY CHECKED, on this machine (`sw_vers`: macOS 27.0,
   * arm64) with the Electron version this app is built against
   * (`node_modules/electron`: 43.4.1): that build's own bundled type
   * declarations (`node_modules/electron/electron.d.ts`, the `powerMonitor`
   * `'shutdown'` event) are annotated `@platform linux,darwin` — darwin
   * support here is NEWER than the "documented for Linux and Windows" belief
   * this ticket started from, which was true of older Electron releases and
   * is not true of this one.
   *
   * That is a claim about the DOCS, not an observation of the EVENT firing.
   * Actually confirming it needs a real logout or restart, and this session
   * deliberately did not trigger one: doing so would have ended this dev
   * session (and everything else running on the machine) along with the
   * app, which is a destructive action nobody asked for just to answer a
   * question the code below already degrades safely without an answer to.
   * `systemShuttingDown` (above) starts false and is flipped only by a real
   * `powerMonitor` `'shutdown'` callback — if that callback never arrives
   * (wrong event, wrong platform build, anything), every quit reads as
   * user-initiated and this warns every time, which IS the ticket's own
   * documented fallback ("warn every time" is a smaller fault than blocking
   * a shutdown), arrived at by construction rather than by a flag nobody
   * checks. Confirming the event actually fires needs a person, on this
   * hardware, watching a real logout — see docs/STC-392-RUNBOOK.md.
   */
  const decision = quitDecision({ unhandled, systemInitiated: systemShuttingDown });
  if (decision === "quit") {
    quitting = true;
    runQuitTeardown();
    return;
  }

  // decision === "warn": a person is still at the keyboard and there is
  // something to lose. Ruling 1: Cancel is both `defaultId` AND `cancelId` —
  // buttons[2] — so Escape does the same thing Return-on-nothing-pressed
  // does, rather than picking the FIRST button the way a dialog that only
  // sets `cancelId` would.
  void dialog.showMessageBox({
    type: "warning",
    buttons: ["Save All", "Quit Anyway", "Cancel"],
    defaultId: 2,
    cancelId: 2,
    message: unhandled === 1 ? "1 take isn't saved" : `${unhandled} takes aren't saved`,
    detail: "Save All writes them to your library, then quits. Quit Anyway leaves them where "
      + "they are — nothing is deleted, and they're offered back the next time you open the app.",
  }).then(async ({ response }) => {
    if (response === 2) return; // Cancel: quit stays prevented, `quitting` stays false.
    if (response === 0) {
      // Save All must not trap the user (ruling 2): a promotion that fails
      // (a full disk, say) is reported and skipped, never retried and never
      // turned into a second dialog. The take that failed stays in temp
      // storage, which is the same backstop Quit Anyway already relies on —
      // STC-393's recovery prompt finds it on the next launch either way.
      for (const dir of unsavedTakeDirs()) {
        await promoteTake(process.env, dir).catch((err) => {
          console.error("[quit] could not save a take before quitting:", dir, err);
        });
      }
    }
    quitting = true;
    runQuitTeardown();
  });
});

ipcMain.handle("recorder:getSettings", async (): Promise<Settings> =>
  readSettings(app.getPath("userData")));

/**
 * The renderer's own preferences, minus the ones it may not name.
 *
 * `still.destination` is main's alone: it decides WHERE THIS PROCESS WRITES,
 * and `resolveExportOptions` documents in as many words that a renderer cannot
 * choose it. That guarantee was true of the export request and false here —
 * this generic handler passed the whole patch through, so the destination was
 * settable after all through a different door. A comment that promises more
 * than the code delivers is worse than no comment.
 *
 * The dedicated channel stays: `still:chooseDestination` sets it from a native
 * folder picker, which is a person choosing, not the renderer.
 */
ipcMain.handle("recorder:setSettings", async (_e, patch: Partial<Settings>): Promise<Settings> => {
  const clean: Partial<Settings> = { ...(patch ?? {}) };
  if (clean.still) {
    // Destructured rather than deleted, so `destination` is named here and a
    // reader can see exactly which key does not survive.
    const { destination: _mainsAlone, ...rest } = clean.still;
    // `writeSettings` merges `still` one level deep, so an absent destination
    // keeps the stored one rather than clearing it.
    clean.still = rest as Partial<Settings>["still"];
  }
  if (clean.share) {
    // Same rule, same reason (STC-242): `share.destination` is a folder in the
    // user's own site repo, and a renderer that could name it could make this
    // process copy a file anywhere it liked. `share:chooseDestination` sets it
    // from a native picker — a person choosing — and the slug and template,
    // which decide only what the file is CALLED and what text is offered for
    // pasting, stay settable from the preferences UI like any other field.
    const { destination: _mainsAlone, ...rest } = clean.share;
    clean.share = rest as Partial<Settings>["share"];
  }
  const saved = writeSettings(app.getPath("userData"), clean);
  // STC-381: a kind change or Clear cancels an in-progress flash (a pick
  // followed immediately by changing your mind) — this is the only door
  // `renderer.ts` uses to write `scope` (a kind change, `clearSource`), so
  // gating on `clean.scope` being present catches every real case. A fresh
  // pick starts its OWN flash from `pickCaptureTarget`, below.
  if (clean.scope) hideScopeIndicator();
  return saved;
});

ipcMain.handle("recorder:devices", async () => {
  if (!sup) throw new Error("supervisor not running");
  return sup.devices();
});

ipcMain.handle("recorder:status", async () => ({
  state: sup?.state ?? "starting",
  pid: sup?.pid,
}));

ipcMain.handle("recorder:start", async () => {
  // STC-381: before anything else, even the `no-capture-target` refusal
  // below — a flash still on screen (Record pressed right after a pick)
  // must never survive into a live take, whether or not the take starts.
  hideScopeIndicator();
  if (!sup) throw new Error("supervisor not running");
  // A still capture in flight owns the overlay, the countdown panel and the
  // helper's attention. Pressing Record into the middle of one used to start a
  // take with that overlay on screen; STC-391 makes the window much easier to
  // hit, since a self-timer spends seconds waiting with the main window still
  // live, so it is refused with something to read rather than left to race.
  if (capturing || overlayIsOpen() || countdownIsOpen()) {
    return { ok: false, code: "capture-in-flight" };
  }
  // Read from the stored preference, NOT passed up from the renderer. Main
  // already owns these settings, and a renderer-supplied value would be a
  // second source of truth for what turns on a physical camera and what the
  // helper is told to point at.
  const { camera, displayId, micDeviceUid, scope, countdownMs } =
    readSettings(app.getPath("userData"));
  const startParams: Record<string, unknown> = { camera };
  // Only when a device is actually picked (STC-233) — an absent field is
  // "no mic" to the helper's own parseStartRequest, and there is no
  // automatic mic the way there is an automatic display.
  if (micDeviceUid != null) startParams.micDeviceUid = micDeviceUid;
  if (scope.kind === "region" && scope.region) {
    const { displayId: regionDisplayId, x, y, width, height } = scope.region;
    startParams.displayId = regionDisplayId;
    startParams.region = { x, y, width, height };
  } else if (scope.kind === "window" && scope.windowId != null) {
    startParams.windowId = scope.windowId;
  } else if (scope.kind === "display") {
    // displayId only when one was picked: absent means "the helper's first",
    // and the helper refuses an id it cannot find (display-not-found) rather
    // than recording another screen (STC-247).
    if (displayId != null) startParams.displayId = displayId;
  } else {
    // The scope picker asks for a region or a window and nothing has been
    // picked yet — refused here, before the helper is ever touched, on the
    // same rule STC-247 already set for a stale displayId: a picker must not
    // have its choice silently swapped for another.
    return { ok: false, code: "no-capture-target" };
  }
  // STC-391: Record ALWAYS counts down — the countdown is what makes Record
  // feel weightier than Capture. After the scope checks above and never
  // before: the ticket makes scope and countdown separate steps, and counting
  // down to a `no-capture-target` refusal would be three seconds spent on
  // nothing.
  //
  // `readSettings` has already clamped it; clamped again so this site reads
  // the same as the capture path and neither has to know which of them
  // sanitised the value.
  const ms = clampCountdownMs(countdownMs);
  if (needsCountdown(ms)) {
    const counted = await runCountdown({
      ms, purpose: "record",
      displayId: countdownDisplayFor(scope, displayId),
      dist: here, rendererDir: join(here, "..", "renderer"),
    });
    // Requirement 1: nothing is recorded. `cancelled` rather than an error
    // code the renderer would put in an alert — the user chose this.
    if (!countdownFired(counted.outcome)) return { ok: false, cancelled: true };
  }
  // Any floating panel still on screen would be IN the take, and unlike a
  // still capture there is no exclusion list for `start` to be added to.
  // CLOSED rather than merely hidden (`closeThumbnail`, the same call quit
  // makes) — hiding it for the length of a recording would leave it sitting
  // out of sight with nothing to bring it back, since nothing times out any
  // more. Its take is left in temp storage rather than exported (STC-392); a
  // pending panel deliberately bumped by starting a recording is a choice the
  // recovery prompt can still surface later, not a silent save.
  // After the countdown, so a cancelled one costs a pending panel nothing.
  await closeThumbnail().catch(() => {});
  // Temp storage, not the library (STC-393): the take is not real until a
  // clean stop promotes it, so a denied grant or a crash mid-recording leaves
  // nothing in the library at all rather than a broken entry someone has to
  // notice and clean up. The helper creates the leaf directory itself and
  // removes it again if the start fails; the root above it is ensured once at
  // launch (`app.whenReady`).
  const root = tempTakesRoot(process.env);
  const existing = existsSync(root) ? readdirSync(root) : [];
  const dir = newTempTakeDir(process.env, new Date(), existing);
  try {
    const r = await sup.startRecording(dir, startParams);
    return { ok: true, dir, info: r };
  } catch (e: any) {
    // A missing Screen Recording grant is the common case and is actionable —
    // surface the helper's own code rather than a generic failure.
    return { ok: false, code: e?.code ?? "start-failed", detail: e?.detail ?? String(e?.message ?? e) };
  }
});

/**
 * The helper's raw `windows` reply, turned into what the overlay wants.
 * `fullyVisible` (STC-380) defaults to `false` — treating a field the helper
 * did not send as "cannot be picked" is the direction that fails safe, not
 * the one that fails open.
 */
function windowsFromReply(r: HelperLine): WindowInfo[] {
  return ((r.windows as any[]) ?? []).map((w) => ({
    id: w.id, app: w.app, title: w.title,
    bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
    fullyVisible: Boolean(w.fullyVisible),
  }));
}

/**
 * Choose what a RECORDING scopes to (STC-370's region/window capability,
 * wired to the window now) — a region or a window, through the same overlay
 * `capture-still` uses (STC-290). Persists the pick as the sticky `scope`
 * preference; a take does not need re-choosing every time it runs, the same
 * way a chosen display stays chosen (STC-247).
 *
 * Guarded the same way `captureStill` is: one overlay at a time, and never
 * while a take is already running — the scope a live recording is using
 * cannot be changed out from under it.
 */
async function pickCaptureTarget(kind: "region" | "window"):
  Promise<{ ok: boolean; cancelled?: boolean; scope?: Settings["scope"] }> {
  if (!sup) return { ok: false };
  if (sup.state === "recording" || capturing || overlayIsOpen()) return { ok: false };

  let windows: WindowInfo[] = [];
  try {
    windows = windowsFromReply(await sup.listWindows());
  } catch {
    // Without a Screen Recording grant the helper cannot enumerate anything.
    // Region mode needs no window list, so the overlay still opens; window
    // mode will simply offer nothing to click, same as still capture.
  }

  const { outcome } = await openOverlay({
    windows, mode: kind, dist: here, renderer: join(here, "..", "renderer"),
  });
  if (outcome.kind === "cancelled") return { ok: true, cancelled: true };

  // Trust what the overlay actually produced, not the mode it was opened in —
  // the mode toggle inside it still works, the same reasoning
  // `selectRegionOrWindow` already follows for still capture.
  const pickedWindow = outcome.kind === "window"
    ? windows.find((x) => x.id === outcome.windowId) : undefined;
  const scope: Settings["scope"] = outcome.kind === "region"
    ? { kind: "region", windowId: null, windowLabel: null,
        region: { displayId: outcome.displayId, ...outcome.crop } }
    : { kind: "window", region: null, windowId: outcome.windowId,
        windowLabel: (() => {
          const label = [pickedWindow?.app, pickedWindow?.title].filter(Boolean).join(" — ");
          return label || `Window ${outcome.windowId}`;
        })() };
  const saved = writeSettings(app.getPath("userData"), { scope });
  // STC-381: confirm the fresh pick with a brief outline, then get out of
  // the way — CONFIRMED ON HARDWARE that showing it persistently on every
  // main-window focus reads as naggy rather than helpful, so this is now
  // the ONLY place the indicator is ever shown. `pickedWindow` is already in
  // hand from the `windows` list fetched above, so this needs no second
  // helper round trip for a fresh bounds lookup.
  flashScopeIndicator({ scope: saved.scope, liveWindow: pickedWindow, rendererDir: join(here, "..", "renderer") });
  return { ok: true, scope: saved.scope };
}

ipcMain.handle("recorder:pickCaptureTarget", async (_e, kind: string) =>
  kind === "region" || kind === "window" ? pickCaptureTarget(kind) : { ok: false });

/**
 * Select, then capture one frame (STC-290 handing off to STC-289), or capture a
 * whole display with no selection at all (STC-292).
 *
 * A FUNCTION, not just an IPC handler: the hotkey and the menu-bar item are the
 * primary entry points now, and neither has a renderer to route through. The
 * button in the window calls exactly this, so there is one capture path with
 * three doors rather than three implementations that can drift.
 *
 * The window list is read from the helper for THIS selection rather than
 * cached: it is stale the moment anything is closed or moved, and the overlay
 * is the one place where showing a window that has gone would hand the capture
 * an id it cannot honour.
 *
 * Nothing touches the disk until there is something to write. A cancelled
 * selection returns without ever asking for a directory, which is what makes
 * "Escape leaves no shot.json on disk" a property of the code rather than a
 * hope — the helper only ever sees a request that a real selection produced.
 */
export interface StillResult {
  ok: boolean;
  cancelled?: boolean;
  dir?: string;
  kind?: string;
  file?: string;
  shot?: unknown;
  warning?: string;
  code?: string;
  detail?: string;
  /** Which door this came through, so the UI can tell a capture it asked for
   * from one that arrived while the user was somewhere else entirely. */
  source?: CaptureSource;
}

type CaptureSource = "window" | "hotkey" | "menu-bar";

async function captureStill(action: ShotAction, source: CaptureSource): Promise<StillResult> {
  // Never throws, whatever the door. A hotkey has no caller to reject to: an
  // exception here would be an unhandled rejection in the main process and a
  // capture that silently did nothing.
  if (!sup) return { ok: false, code: "helper-not-running", source };
  // A second press while one is in flight is a no-op, not a second overlay and
  // not a second directory. `countdownIsOpen` is the STC-391 addition: a
  // self-timer spends most of its life with no overlay up at all, so the
  // `overlayIsOpen` half stopped covering the whole of "a capture is running"
  // the moment a countdown could sit between the two.
  if (capturing || overlayIsOpen() || countdownIsOpen()) {
    return { ok: false, code: "overlay-open", source };
  }

  capturing = true;
  tray?.update({ shortcuts, busy: true });
  try {
    // Whatever panel is on screen from a PREVIOUS capture must be out of this
    // one's pixels (STC-296's acceptance list: "including a full-display
    // capture on the same display") and out from underneath the overlay, if
    // one is about to open. Cheap when nothing is showing — see `beforeCapture`.
    const thumbExcluded = await hideThumbnailForCapture();
    const outcome = action === "display"
      ? await wholeDisplay(thumbExcluded)
      // The self-timer picks its scope through the SAME overlay, opened in
      // region mode — the overlay's own toggle still reaches window mode, so
      // "scope is chosen during the flow" costs it no second picker.
      : await selectRegionOrWindow(action === "self-timer" ? "region" : action, thumbExcluded);
    if (outcome === undefined) return { ok: false, cancelled: true, source };

    // STC-391. Scope first, countdown second — the ticket makes them separate
    // steps, and a countdown that ran before the selection would be three
    // seconds spent in front of a picture nobody had framed yet. The panels
    // hidden above stay hidden throughout, which is the second half of the
    // ticket's "neither is any waiting floating panel".
    if (action === "self-timer") {
      const ms = clampCountdownMs(readSettings(app.getPath("userData")).countdownMs);
      if (needsCountdown(ms)) {
        const counted = await runCountdown({
          ms, purpose: "capture", displayId: displayIdOf(outcome.params),
          dist: here, rendererDir: join(here, "..", "renderer"),
        });
        // Escape is the ticket's requirement 1: nothing is captured, and this
        // is reported as a cancellation rather than a failure so no door shows
        // an error for something the user chose.
        if (!countdownFired(counted.outcome)) return { ok: false, cancelled: true, source };
        excludeAlso(outcome.params, counted.excludeWindowIds);
      }
    }

    // Temp storage, not the library (STC-393) — see `recorder:start`'s
    // identical reasoning. The panel (below) is what decides whether this
    // capture ever becomes a library entry.
    const root = tempTakesRoot(process.env);
    const existing = existsSync(root) ? readdirSync(root) : [];
    const dir = newTempTakeDir(process.env, new Date(), existing);
    const r = await sup.captureStill({ dir, ...outcome.params });
    // The sound is the ONLY feedback a full-display hotkey capture gives — no
    // overlay was ever on screen — so it is played on every successful shot,
    // for the same reason macOS plays one. Not awaited: the shot is already on
    // disk, and a wedged speaker must not delay the answer.
    //
    // The preference is read HERE rather than cached at launch, for the same
    // reason the system's own sound setting is: someone who has just unticked
    // it means the next capture, not the next launch.
    void playShutter({ enabled: readSettings(app.getPath("userData")).shutterSound })
      .catch(() => {});
    // The panel (STC-296), presented from HERE rather than from any window's
    // renderer: a capture from the hotkey or the menu bar has no window at
    // all, and the panel is the only place a decorated still can be gotten out
    // of the app in v1. `skip` bypasses it entirely: the ticket's own words are
    // "go straight to clipboard", so a silent capture always copies — fixed by
    // `thumbnail-window.ts` the moment `silent` is set, never a preference
    // (STC-392 removed the general settle-action one this used to fall back to).
    // Never lets a panel failure cost the CAPTURE — the shot is already on
    // disk in `dir` by this point, the same "nothing lost by doing nothing"
    // rule the old still panel followed for exactly this reason.
    try {
      const { thumbnail } = readSettings(app.getPath("userData"));
      presentThumbnail({
        dir, shot: r.shot, corner: thumbnail.corner,
        take: { kind: "shot", origin: "fresh" },
        dist: here, rendererDir: join(here, "..", "renderer"),
        ...(thumbnail.skip ? { silent: true } : {}),
      });
    } catch (e) {
      console.error("[thumbnail] could not present:", e);
    }
    // The helper's reply is a JSON line, so its fields arrive as `unknown`;
    // named here rather than spread, so a renamed field is a type error and not
    // a silently absent one.
    return { ok: true, dir, kind: outcome.kind, shot: r.shot,
             file: r.file as string | undefined,
             warning: r.alphaWarning as string | undefined, source };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "still-failed",
             detail: e?.detail ?? String(e?.message ?? e), source };
  } finally {
    capturing = false;
    // Every exit, the cancelled one included: `hideThumbnailForCapture` hides
    // panels that are NOT about to be replaced, so anything that returns
    // without presenting a new one has to put the stack back.
    showThumbnailsAfterCapture();
    tray?.update({ shortcuts, busy: false });
  }
}

interface CaptureParams { kind: string; [k: string]: unknown }

/** The overlay path. `undefined` is a cancellation, which writes nothing. */
async function selectRegionOrWindow(
  action: Extract<ShotAction, "region" | "window">,
  thumbExcluded: number[],
): Promise<{ kind: string; params: CaptureParams } | undefined> {
  let windows: WindowInfo[] = [];
  try {
    windows = windowsFromReply(await sup!.listWindows());
  } catch {
    // Without a Screen Recording grant the helper cannot enumerate anything.
    // The overlay still opens — region mode needs no window list — and the
    // capture below reports the real reason, which is more use to the user
    // than refusing to open with a message about windows they did not ask for.
  }

  const { outcome, excludeWindowIds } = await openOverlay({
    windows, mode: action, dist: here, renderer: join(here, "..", "renderer"),
  });
  if (outcome.kind === "cancelled") return undefined;
  return outcome.kind === "region"
    // `displayId` is Electron's, which on macOS is the CGDirectDisplayID the
    // helper matches against. If that ever stops being true the helper answers
    // `no-such-display` and the capture fails loudly — it cannot silently
    // photograph the wrong screen, which is the failure worth designing out.
    // The overlay's own excluded windows and the thumbnail's (STC-296) are
    // combined here — a WINDOW capture needs neither, since its own filter
    // names exactly one window and cannot accidentally include another.
    ? { kind: "region",
        params: { kind: "display-crop", displayId: outcome.displayId,
                  crop: outcome.crop, excludeWindowIds: [...excludeWindowIds, ...thumbExcluded] } }
    : { kind: "window", params: { kind: "window", windowId: outcome.windowId } };
}

/**
 * The whole display the pointer is on, with no overlay and no selection.
 *
 * The pointer rather than the recording preference or the main display: a
 * hotkey is pressed while looking at something, and the thing being looked at
 * is the one under the cursor. It is also the only rule that needs nothing on
 * screen to disambiguate, which is the point of this action existing.
 *
 * No crop is sent — the helper reads an absent crop as the whole display — but
 * a showing thumbnail (STC-296) still needs excluding: "no overlay" is not
 * "nothing else is on screen."
 */
async function wholeDisplay(thumbExcluded: number[]): Promise<{ kind: string; params: CaptureParams }> {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return { kind: "display",
           params: { kind: "display-crop", displayId: display.id,
                     ...(thumbExcluded.length ? { excludeWindowIds: thumbExcluded } : {}) } };
}

/**
 * Which display a RECORDING is aimed at, for the countdown's benefit.
 *
 * A region scope names one; a display scope names one when the user picked it.
 * A window scope does not — finding it would mean a second helper round trip
 * for a window whose bounds nothing else here needs — and neither does an
 * automatic display, where the helper picks its own first. Both fall through
 * to the pointer's display, which is where the person pressing Record is
 * looking.
 */
function countdownDisplayFor(scope: Settings["scope"], displayId: number | null): number | undefined {
  if (scope.kind === "region" && scope.region) return scope.region.displayId;
  if (scope.kind === "display" && displayId != null) return displayId;
  return undefined;
}

/**
 * Which display a capture is aimed at, when its parameters say — so the
 * countdown appears on the screen being photographed rather than wherever the
 * pointer drifted to. A window capture does not say, and falls back to the
 * pointer's display inside `runCountdown`.
 */
function displayIdOf(params: CaptureParams): number | undefined {
  return typeof params.displayId === "number" ? params.displayId : undefined;
}

/**
 * Add the countdown panel's own window id to a capture's exclusion list.
 *
 * The panel is already hidden and destroyed by the time this is called — this
 * is the belt to that brace, the same pairing `overlay-session.ts` uses,
 * because a hide and a capture reach the window server down different paths
 * with no ordering between them.
 *
 * Only a `display-crop` capture needs it. A `window` capture's filter names
 * exactly one window and cannot accidentally include another, which is why the
 * still path has never sent an exclusion list for one.
 */
function excludeAlso(params: CaptureParams, ids: number[]): void {
  if (ids.length === 0 || params.kind !== "display-crop") return;
  const existing = Array.isArray(params.excludeWindowIds) ? params.excludeWindowIds as number[] : [];
  params.excludeWindowIds = [...existing, ...ids];
}

/**
 * A hotkey or menu-bar capture has no renderer waiting on a reply, so its
 * outcome is announced instead. A window that happens to be open updates its
 * take list and says what happened; one that is not open misses nothing,
 * because the shot is already on disk.
 */
async function captureAndAnnounce(action: ShotAction, source: CaptureSource): Promise<void> {
  const r = await captureStill(action, source);
  send("still:captured", r);
}

ipcMain.handle("still:capture", async (_e, action?: ShotAction) =>
  captureStill(action && SHOT_ACTIONS.includes(action) ? action : "region", "window"));

/**
 * Register what preferences asked for, and report what actually took.
 *
 * `planShortcuts` refuses what is knowably wrong before anything is attempted;
 * `globalShortcut.register` is the authority on the rest and returns false when
 * something else on the machine already holds the binding. Both answers reach
 * the same report, kept apart by their `problem`, because "macOS owns this" and
 * "some other app owns this" have different fixes.
 *
 * Everything is unregistered first: re-registering an accelerator that is still
 * held returns false, which would report a working binding as unavailable the
 * second time a user opened preferences.
 */
function applyShortcuts(next: Shortcuts): ShortcutReport[] {
  shortcuts = next;
  globalShortcut.unregisterAll();
  shortcutReport = planShortcuts(next).map((plan): ShortcutReport => {
    if (plan.problem !== undefined || plan.accelerator == null) {
      return { ...plan, registered: false };
    }
    let ok = false;
    try {
      ok = globalShortcut.register(plan.accelerator,
                                   () => { void captureAndAnnounce(plan.action, "hotkey"); });
    } catch {
      // A binding Electron cannot even parse. Reported as unavailable rather
      // than crashing the app on a preferences file someone edited by hand.
      ok = false;
    }
    return ok ? { ...plan, registered: true } : { ...plan, problem: "unavailable", registered: false };
  });
  tray?.update({ shortcuts, busy: capturing });
  return shortcutReport;
}

ipcMain.handle("shortcuts:get", async () => ({ shortcuts, report: shortcutReport }));

ipcMain.handle("shortcuts:set", async (_e, action: ShotAction, accelerator: string | null) => {
  if (!SHOT_ACTIONS.includes(action)) throw new Error(`unknown capture action: ${action}`);
  const plan = planShortcuts({ ...shortcuts, [action]: accelerator })
    .find((p) => p.action === action)!;
  if (plan.problem !== undefined) {
    // Refused BEFORE anything is stored — the acceptance criterion is that a
    // binding macOS has already claimed is rejected, and a rejection that
    // quietly wrote the default instead would leave the user believing they
    // had bound ⌘⇧4. The previous binding stays live and stays registered;
    // only the report changes, so preferences can say why.
    return {
      shortcuts,
      report: shortcutReport.map((r) => r.action === action ? { ...plan, registered: false } : r),
    };
  }
  // Stored first, then applied: what is on disk is what the next launch will
  // try. A binding that parses but that some other app holds is still the
  // user's choice — it is reported as unavailable, not reverted behind them.
  const saved = writeSettings(app.getPath("userData"),
                              { shortcuts: { ...shortcuts, [action]: plan.accelerator } });
  return { shortcuts: saved.shortcuts, report: applyShortcuts(saved.shortcuts) };
});

ipcMain.handle("shortcuts:reset", async () => {
  const saved = writeSettings(app.getPath("userData"), { shortcuts: { ...DEFAULT_SHORTCUTS } });
  return { shortcuts: saved.shortcuts, report: applyShortcuts(saved.shortcuts) };
});

ipcMain.handle("recorder:stop", async () => {
  if (!sup) throw new Error("supervisor not running");
  // `stopRecording` promotes the take out of temp storage on its own
  // (STC-393) — no recording panel exists yet (STC-392), so a clean stop IS
  // the save.
  const r = await sup.stopRecording();
  return { ok: true, info: r };
});


// ---- the library: one index over two kinds (STC-294) ----------------------

ipcMain.handle("library:list", async (_e, filter?: string) =>
  listLibrary(process.env, typeof filter === "string" ? filter : undefined));

/**
 * Cache a decorated thumbnail beside the document it was rendered from.
 *
 * In the take DIRECTORY, deliberately, and that choice is what makes the
 * ticket's delete criterion — *"delete removes the frame, shot.json and
 * thumbnail with no orphans"* — true by construction rather than by
 * remembering: `take:delete` trashes the whole directory, so the thumbnail
 * goes with it and an orphan is not merely unlikely but unreachable. A cache
 * in userData would need its own eviction, which is the orphan the criterion
 * names.
 *
 * The filename is fixed rather than supplied, so there is no name to traverse
 * with; what IS checked is that the bytes are actually a PNG. The renderer is
 * the sandboxed side, and "write these bytes into the user's take folder" is
 * worth exactly one magic-number check.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

ipcMain.handle("library:writeThumbnail", async (_e, dir: string, bytes: ArrayBuffer) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to write a path outside the recordings folder");
  }
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error("refusing to cache a thumbnail that is not a PNG");
  }
  await writeFile(join(dir, THUMBNAIL_FILE), buf);
  return true;
});

/**
 * Re-open a stored shot into the post-capture panel (STC-294).
 *
 * The payoff of keeping the decoration in JSON: the panel is handed the STORED
 * document, so the mode, the canvas and STC-297's redaction regions all come
 * back exactly as they were left, and the shot can be re-exported without
 * re-capturing. It is the same panel a fresh capture gets — not a second still
 * UI, which is what STC-293's Note and STC-300's gate both forbid.
 *
 * `take: { kind: "shot", origin: "library" }` is the one difference and it
 * still matters post-STC-392: `actionsFor` (`panel-actions.ts`) gives a
 * re-opened shot only Copy and Trash — no Save, because it is already on
 * disk and there is nothing to promote, where a fresh capture also gets
 * Save. Neither panel closes itself any more; both wait for a person to
 * choose one of the actions they actually have.
 * `app/test/library.e2e.test.ts`'s "re-opening a shot from the library
 * offers only Copy and Trash, and never exports on its own" is what actually
 * invokes this handler.
 */
/** The stored document for one shot, so the library can render its decoration. */
ipcMain.handle("library:shot", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to read a path outside the recordings folder");
  }
  return parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
});

ipcMain.handle("still:reopen", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to open a path outside the recordings folder");
  }
  const shot = parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
  const { thumbnail } = readSettings(app.getPath("userData"));
  presentThumbnail({
    dir, shot, corner: thumbnail.corner,
    take: { kind: "shot", origin: "library" },
    dist: here, rendererDir: join(here, "..", "renderer"),
  });
  return { ok: true };
});

/**
 * Copy a shot so a second decoration can be tried without re-capturing.
 *
 * The new directory gets a fresh timestamp from the same `newTakeDir` a
 * capture uses, so the duplicate sorts as what it is — made now. The copy and
 * its race-safety (STC-345: a double-click or two tiles duplicated in the
 * same second used to be able to collide on one destination) live in
 * `duplicateTake`; this handler is only validation and the IPC boundary.
 */
ipcMain.handle("still:duplicate", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to duplicate a path outside the recordings folder");
  }
  // Read it back through `parseShot` first: duplicating a document this build
  // cannot load would produce a second directory the library also refuses.
  parseShot(JSON.parse(await readFile(join(dir, "shot.json"), "utf8")));
  const dest = await duplicateTake(process.env, dir, THUMBNAIL_FILE);
  return { ok: true, dir: dest };
});

ipcMain.handle("recorder:takes", async () => listTakes(process.env));

ipcMain.handle("take:label", async (_e, dir: string, label: string) => {
  await setTakeLabel(process.env, dir, label);
  return true;
});

/**
 * Ask first, then move to the Trash — never `rm`, so a mistaken click is one
 * Finder restore away. `take:delete`'s original body (STC-294), lifted out
 * here (STC-392 Task 6) so `panel:trash`'s "confirm" style (`trashStyle`,
 * `panel-actions.ts`) can call the SAME dialog rather than a second copy
 * asking the same question with a second string — two modals for one
 * question is exactly the "one value, two copies" defect this codebase keeps
 * finding. Both callers already validate the directory against their own
 * root before reaching this; it does not re-check.
 */
async function trashWithConfirmation(dir: string): Promise<{ ok: boolean; detail?: string }> {
  if (!win) return { ok: false, detail: "no window" };
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Move to Trash", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Move this take to the Trash?",
    detail: dir,
  });
  if (response !== 0) return { ok: false, detail: "cancelled" };

  // A window with this take open no longer has anywhere valid to write.
  for (const [sid, d] of openTakes) if (d === dir) openTakes.delete(sid);
  await shell.trashItem(dir);
  // No-op unless a panel is showing this take (the `panel:trash` "confirm"
  // path — a re-opened library shot); `take:delete`'s own caller (the
  // library grid) never has one open for the take it is deleting.
  dismissThumbnail(dir);
  return { ok: true };
}

ipcMain.handle("take:delete", async (_e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to delete a path outside the recordings folder");
  }
  const r = await trashWithConfirmation(dir);
  return { deleted: r.ok };
});

ipcMain.handle("preview:open", async (e, dir: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to open a path outside the recordings folder");
  }
  setOpenTake(e, dir);
  return true;
});

ipcMain.handle("preview:close", async (e) => { clearOpenTake(e); });

/**
 * Open the editor window on a take (STC-373) — the library's "Preview" action
 * for a recording, which used to open the main window's own in-page player.
 *
 * A FUNCTION the main window's preload calls, the same shape `still:capture`
 * already is: the window that gets created is `editor-window.ts`'s concern,
 * not something the renderer reaches with its own `BrowserWindow`.
 */
ipcMain.handle("editor:open", async (_e, dir: string, name: string) => {
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to open a path outside the recordings folder");
  }
  openEditor({ dir, name, dist: here, rendererDir: join(here, "..", "renderer") });
  return true;
});

ipcMain.handle("preview:writeProject", async (e, bytes: ArrayBuffer) => {
  const openTake = getOpenTake(e);
  if (!openTake) throw new Error("no take is open");
  const text = Buffer.from(bytes).toString("utf8");
  let doc: any;
  try { doc = JSON.parse(text); }
  catch { throw new Error("project.json is not JSON"); }
  // ONE list, imported (STC-318). This used to be a hand-rolled chain, and its
  // own comment claimed it "cannot share a constant with the transform's" —
  // untrue, this file already imports from @transform. The comment also
  // recorded that the pair had drifted once, when project-2 was minted; it
  // then drifted again when project-4 shipped, and for a day a take with a
  // non-default zoom could not be saved at all, silently. No test could see
  // it: the unit tests never cross this process line, and every document the
  // E2E tests wrote happened to be a v3.
  if (!isProjectVersion(doc?.version)) {
    throw new Error(`project.json version ${doc?.version} is not supported`);
  }
  await writeFile(join(openTake, "project.json"), text);
  return true;
});

ipcMain.handle("export:write", async (e, name: string, bytes: ArrayBuffer) => {
  const openTake = getOpenTake(e);
  if (!openTake) throw new Error("no take is open");
  // The renderer chooses a filename; constrain it to a leaf name with a known
  // extension so it cannot traverse out of the take directory.
  if (!/^[A-Za-z0-9._-]+\.(mp4|json|png)$/.test(name) || name.includes("..")) {
    throw new Error(`refusing to write "${name}"`);
  }
  // Source media is never mutated. The leaf-name rule above still admitted
  // display.mp4, camera.mp4 and the sidecars — an export named after one of
  // them would have replaced the recording with its own rendering.
  if (TAKE_FILES.has(name) || name === "take.json") {
    throw new Error(`refusing to overwrite the take's own "${name}"`);
  }
  const dest = join(openTake, name);
  await writeFile(dest, Buffer.from(bytes));
  return dest;
});

/**
 * The one way a still leaves the app (STC-293).
 *
 * Every caller reaches disk and pasteboard through here: the preview's frame
 * grab (STC-298, migrated onto this in the same change) and the floating
 * thumbnail's own window (STC-296), each through its own preload but the same
 * handler. The ticket's Note forbids a second implementation, and the way
 * that rule stays true is that there is exactly one handler and it takes
 * composited pixels rather than an encoded image — an encoded image would
 * mean the caller had already chosen a format, which is half the decision
 * this path exists to own.
 *
 * The renderer sends RGBA because it has a canvas and no encoder; the helper
 * encodes because ImageIO is the only thing here that can write HEIC, embed a
 * Display P3 profile, and withhold a capture timestamp.
 */
ipcMain.handle("still:export", async (_e, req: {
  bytes: ArrayBuffer; width: number; height: number; alpha: boolean;
  colorSpace?: string;
  target: ExportTarget;
  options: Partial<ExportOptions>;
  info: { app?: string; title?: string; mode: string };
  /** A take directory, for the "beside the shot" default destination. */
  dir?: string;
}) => {
  if (!sup) throw new Error("supervisor not running");
  const stored = readSettings(app.getPath("userData")).still;

  // What the renderer may decide about this one export, and what only the
  // stored preference decides. In `still-io.ts` rather than inline here: a
  // closure in `ipcMain.handle` is unreachable from any test, and the first
  // version of this pinned the template to the stored one, which renamed
  // every saved frame.
  const options = resolveExportOptions(stored, req.options);

  // The decision point, narrowed by STC-392 (D5). It used to be "every
  // `still:export` call is a keep", which was true while Copy was terminal.
  // The panel now stays open after a Copy so the user can still Save — or
  // Trash — and a Copy that had promoted would leave that Trash deleting
  // something already sitting in the library.
  //
  // `req.target.file` is the predicate, not an action name: this handler is
  // reached by the panel, the main window and the editor alike, and "does
  // this export write a file" is the one question all three can answer.
  // Save As is a file write and so promotes, which is correct — it is a save
  // that asks first, not a different outcome. `dir` is reassigned rather
  // than left as `req.dir` so the reply can hand the renderer its new
  // location.
  let dir = req.dir && insideCaptureRoot(process.env, req.dir) ? req.dir : undefined;
  if (dir && req.target.file) {
    try { dir = await promoteTake(process.env, dir); }
    catch (e) {
      console.error("[still] could not move the shot into the library:", dir, e);
    }
  }

  // A take directory is the only fallback destination that may be named, and
  // it must be inside the recordings root (or, before promotion above ran,
  // the temp root) — the renderer is sandboxed and never gets to point the
  // writer at an arbitrary path. `insideCaptureRoot`, not `startsWith`: this
  // path is handed to the helper, which CREATES directories and writes an
  // image at it. A `..` segment or a sibling folder with the same prefix both
  // pass a prefix test.
  const fallbackDir = dir && insideCaptureRoot(process.env, dir) ? dir : undefined;

  const still: CompositedStill = {
    bytes: req.bytes,
    width: req.width,
    height: req.height,
    alpha: req.alpha === true,
    colorSpace: colorSpaceFor(req.colorSpace),
  };
  // "Save As…" (STC-296's right-click menu). The renderer asked to choose; it
  // does not get to say WHAT was chosen. Main puts the panel up, and the path
  // that comes back is the privileged `explicitFile` — the same division
  // `still:writeShot` makes, where the renderer names regions and never a
  // document.
  let explicitFile: string | undefined;
  if (req.target.saveAs === true) {
    const parent = BrowserWindow.getFocusedWindow() ?? win;
    const suggested = plannedFileName(options, req.info, { width: req.width, height: req.height });
    const picked = await (parent
      ? dialog.showSaveDialog(parent, { title: "Save Shot", defaultPath: suggested })
      : dialog.showSaveDialog({ title: "Save Shot", defaultPath: suggested }));
    // Cancelling is an answer, not a failure: it must not fall through to a
    // silent save in the destination folder, which is the one outcome someone
    // who opened this dialog has ruled out.
    if (picked.canceled || !picked.filePath) return { ok: false, cancelled: true };
    explicitFile = picked.filePath;
  }

  try {
    const r = await exportStill((params) => sup!.exportStill(params),
                                { still, target: req.target, options, info: req.info,
                                  ...(explicitFile ? { explicitFile } : {}),
                                  ...(fallbackDir ? { fallbackDir } : {}) },
                                // `stored`, never the merged options: the
                                // destination folder and the strip are read
                                // from here, and both are main's alone.
                                stored, app.getPath("temp"));
    // Only a save is worth revealing. A copy's file lives in the cache and
    // exists so the pasteboard's URL points somewhere, not for the user.
    if (req.target.file && r.file) lastStillFile = r.file;
    // `dir` only when it moved (STC-393): the renderer holds its own copy for
    // every later call (redact, reveal, discard) and must update it once the
    // shot has a new home, but a caller with no take of its own (the editor's
    // frame grab) never sent one and should not be handed one back.
    return { ok: true, ...r, ...(dir ? { dir } : {}) };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "export-failed",
             detail: e?.detail ?? String(e?.message ?? e) };
  }
});

/**
 * The destination folder, chosen by the user.
 *
 * A folder picker rather than a save panel, deliberately: the ticket's default
 * path out of the app is "no interaction at all", so the place is chosen once
 * and every subsequent export is silent. A save panel per shot would be the
 * interaction the design is trying to remove.
 */
ipcMain.handle("still:chooseDestination", async () => {
  if (!win) throw new Error("no window");
  const current = readSettings(app.getPath("userData")).still.destination;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Where should shots be saved?",
    properties: ["openDirectory", "createDirectory"],
    ...(current ? { defaultPath: current } : {}),
    buttonLabel: "Choose",
  });
  if (canceled || !filePaths[0]) return { destination: current };
  const destination = filePaths[0];
  writeSettings(app.getPath("userData"), { still: { ...readSettings(app.getPath("userData")).still, destination } });
  return { destination };
});

/**
 * The floating thumbnail's right-click menu (STC-296 follow-up).
 *
 * Built here and popped up here: `buildThumbMenu` decides the contents
 * where a test can read them, and this turns them into the one thing no test
 * can — a real `Menu`. Answers with the chosen id, or `null` when the menu was
 * dismissed, so the renderer performs the action with the same code its own
 * buttons use.
 */
ipcMain.handle("thumbnail:menu", async (e, ctx: ThumbMenuContext) => {
  const owner = BrowserWindow.fromWebContents(e.sender) ?? undefined;
  return await new Promise<ThumbMenuId | null>((resolve) => {
    let answered = false;
    const answer = (id: ThumbMenuId | null) => { if (!answered) { answered = true; resolve(id); } };
    const menu = Menu.buildFromTemplate(buildThumbMenu({
      // A malformed or absent `take` defaults to a fresh shot — the widest
      // set of the four actions minus Edit — rather than throwing and losing
      // the whole menu over one bad field on a channel only this app's own
      // renderer ever calls.
      take: ctx?.take ?? { kind: "shot", origin: "fresh" },
      redacting: ctx?.redacting === true, busy: ctx?.busy === true,
    }).map((item) => item.type === "separator"
      ? { type: "separator" as const }
      : { label: item.label, enabled: item.enabled !== false, click: () => answer(item.id) }));
    // `callback` fires on dismissal too, and AFTER any click — so a menu closed
    // without a choice still settles the promise. Without it the renderer waits
    // forever on an `await` for a menu that is no longer on screen, which is
    // the unbounded-wait trap this repo keeps re-learning.
    menu.popup({ ...(owner ? { window: owner } : {}), callback: () => answer(null) });
  });
});

/**
 * Write the decorated file a drag-out will hand over (STC-296 follow-up).
 *
 * Goes through the SAME funnel as every other exit, using #98's
 * `explicitFile` exactly as it was built: main names the destination, the
 * renderer never does. The destination is the clipboard cache, for the reason
 * `CLIPBOARD_SUBDIR` exists — someone dragging a shot into Slack did not ask
 * for a copy to accumulate in their shots folder.
 *
 * A separate VERB rather than a flag on `ExportTarget`: a drag is not a save
 * and not a copy, and folding it into either would set `lastStillFile` — so
 * Reveal in Finder would jump to a file the user never asked to keep.
 */
ipcMain.handle("still:dragFile", async (_e, req: {
  bytes: ArrayBuffer; width: number; height: number; alpha: boolean;
  colorSpace?: string;
  options: Partial<ExportOptions>;
  info: { app?: string; title?: string; mode: string };
}) => {
  if (!sup) throw new Error("supervisor not running");
  const stored = readSettings(app.getPath("userData")).still;
  const options = resolveExportOptions(stored, req.options);
  const still: CompositedStill = {
    bytes: req.bytes, width: req.width, height: req.height,
    alpha: req.alpha === true, colorSpace: colorSpaceFor(req.colorSpace),
  };
  const cache = join(app.getPath("temp"), CLIPBOARD_SUBDIR);
  try {
    const r = await exportStill((params) => sup!.exportStill(params), {
      still, target: { file: true, clipboard: false }, options, info: req.info,
      explicitFile: join(cache, plannedFileName(options, req.info, still)),
    }, stored, app.getPath("temp"));
    // Deliberately NOT `lastStillFile`: see the note above.
    return { ok: true, file: r.file };
  } catch (e: any) {
    return { ok: false, code: e?.code ?? "export-failed",
             detail: e?.detail ?? String(e?.message ?? e) };
  }
});

/**
 * Hand the file to the window server (STC-296 follow-up).
 *
 * `startDrag` is reached through pointer events rather than an HTML5
 * `dragstart`, and that is the point: making the card `draggable` would put a
 * native drag in the same pixels as the swipe's pointer gesture, and the two
 * would race for every press. Electron lets `startDrag` be called from
 * anywhere, so the panel stays on one input model and `classifyDrag` remains
 * the only thing deciding what a press means.
 *
 * NOT `NSFilePromiseProvider`, per STC-293: a promise needs a live provider to
 * answer at paste time, the helper has answered and gone idle by then, and a
 * promise nobody answers hands the receiver a ZERO-BYTE file.
 */
ipcMain.on("still:startDrag", (e, file: string) => {
  if (typeof file !== "string" || !existsSync(file)) return;
  // macOS refuses an empty drag icon. Built from the file being dragged, so
  // what the cursor carries is what will land.
  const icon = nativeImage.createFromPath(file).resize({ width: 128 });
  if (icon.isEmpty()) return;
  e.sender.startDrag({ file, icon });
});

/**
 * Show a SHOT's own directory in the Finder.
 *
 * Distinct from `still:reveal`, which shows the last saved file: a thumbnail
 * that has not settled yet has saved nothing, and revealing some earlier
 * shot instead of the one under the pointer would be worse than refusing.
 * `insideTakesRoot` for the same reason every other renderer-named path gets
 * it — a prefix test passes a `..` segment.
 */
ipcMain.handle("still:revealShot", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir) || !existsSync(dir)) return false;
  shell.showItemInFolder(dir);
  return true;
});

/**
 * The panel's three take-moving actions (STC-392).
 *
 * Separate from `still:export` on purpose: that handler answers "turn these
 * pixels into a file or a clipboard entry", which the editor and the main
 * window ask too. These three answer "what happens to this TAKE", which only
 * the panel asks — and each of them is reached by up to four different
 * gestures in the panel (a button, the ⌘ keyboard accelerator, the context
 * menu, and for trash a swipe), so a single handler each is what keeps those
 * from drifting.
 *
 * Every one validates the directory against the capture roots before it acts.
 * The renderer names a take; it never hands main a path to act on.
 */
ipcMain.handle("panel:save", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  try {
    // Asked, not assumed: `promotes("save")` is `panel-actions.ts`'s own
    // answer, not a second place this handler decides "save promotes" for
    // itself. If that predicate ever disagreed with what this does, the two
    // copies of "save promotes" this repo has already paid for five ways
    // (CLAUDE.md) would be back, just split across a renderer file and this
    // one instead of two renderer files.
    const promoted = promotes("save") ? await promoteTake(process.env, dir) : dir;
    dismissThumbnail(dir);
    return { ok: true, dir: promoted };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
});

/**
 * Edit promotes first, and not as a convenience: `editor:open` refuses any
 * path outside the recordings root, so a take in temp storage cannot be
 * opened at all. The editor's own Save is about the EXPORT — the ticket's
 * "you may only be trimming" — not about whether the take is kept, which is
 * what this promote settles.
 */
ipcMain.handle("panel:edit", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  try {
    // Same reasoning as `panel:save` above: `promotes("edit")` is asked, not
    // hardcoded — this handler has no opinion of its own about whether Edit
    // promotes.
    const opened = promotes("edit") ? await promoteTake(process.env, dir) : dir;
    openEditor({ dir: opened, name: basename(opened),
                 dist: here, rendererDir: join(here, "..", "renderer") });
    dismissThumbnail(dir);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
});

/**
 * Throw a take away (STC-296's right-click Delete, and now the ✕ button, the
 * ⌘⌫ key and the swipe).
 *
 * Two styles, decided by `trashStyle(origin)` (`panel-actions.ts`, D1) —
 * never a second opinion here about which take gets which: a take re-opened
 * from the library is already kept, so deleting it is destroying something
 * the user chose and gets `trashWithConfirmation`'s modal, the same one
 * `take:delete` uses. A fresh capture still in temp storage gets the timed
 * undo (STC-392 Task 6, `pending-trash.ts`): nothing is trashed yet. The ✕
 * PROMISES to, closes the panel, and puts up a toast; the promise is kept by
 * the sweep in `app.whenReady()` once `UNDO_WINDOW_MS` elapses, or broken by
 * `panel:undoTrash` before then. `shell.trashItem` has no inverse, so this is
 * the only version of "undo" that does not lie about what the filesystem can
 * do — see `pending-trash.ts`'s module doc for the whole reasoning.
 */
ipcMain.handle("panel:trash", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) {
    return { ok: false, detail: "not a take this app wrote" };
  }
  const origin = insideTempTakesRoot(process.env, dir) ? "fresh" : "library";
  if (trashStyle(origin) === "confirm") return trashWithConfirmation(dir);

  if (!existsSync(dir)) { dismissThumbnail(dir); return { ok: true }; }
  pendingTrash.promise(dir);
  dismissThumbnail(dir);
  showUndoToast({
    dir, corner: readSettings(app.getPath("userData")).thumbnail.corner,
    dist: here, rendererDir: join(here, "..", "renderer"),
  });
  return { ok: true };
});

/**
 * Break a promise `panel:trash` made, and bring the panel back.
 *
 * `false` when there was nothing to take back — `PendingTrash.undo` already
 * refuses a take that was never promised or has already been committed, so a
 * stale toast (or a doubled click) cannot reopen a panel for a take already
 * in the Trash. On success the panel is re-presented from the STORED shot
 * document, exactly like `still:reopen`/crash recovery — nothing was ever
 * moved, so the take is still sitting in temp storage under `dir`.
 */
ipcMain.handle("panel:undoTrash", async (_e, dir: string) => {
  if (typeof dir !== "string" || !insideCaptureRoot(process.env, dir)) return false;
  if (!pendingTrash.undo(dir)) return false;
  hideUndoToast();
  try {
    const shot = JSON.parse(await readFile(join(dir, "shot.json"), "utf8"));
    const { thumbnail } = readSettings(app.getPath("userData"));
    presentThumbnail({
      dir, shot, corner: thumbnail.corner,
      // A promise only ever exists for a take Save/Save-All could otherwise
      // resurrect (`trashStyle` above), which is exactly `origin: "fresh"` —
      // an undone deletion is nothing more than the panel it was closed from,
      // reopened.
      take: { kind: "shot", origin: "fresh" },
      dist: here, rendererDir: join(here, "..", "renderer"),
    });
  } catch (e) {
    console.error("[trash] could not re-present after undo:", dir, e);
  }
  return true;
});

/** Show the last SAVED still in the Finder. Takes no path — see `lastStillFile`. */
ipcMain.handle("still:reveal", async () => {
  if (!lastStillFile) return false;
  shell.showItemInFolder(lastStillFile);
  return true;
});

/** Back to "beside the shot", without needing a folder picker to express it. */
ipcMain.handle("still:clearDestination", async () => {
  const still = readSettings(app.getPath("userData")).still;
  writeSettings(app.getPath("userData"), { still: { ...still, destination: null } });
  return { destination: null };
});

/**
 * The captured frame's bytes, for the still panel to decorate.
 *
 * Guarded exactly like `preview:read`: a leaf name inside a directory the main
 * process is willing to name, never a path the renderer chose. The stills the
 * renderer may open are the ones under the recordings root, which is the only
 * place `still:capture` ever writes.
 */
ipcMain.handle("still:frame", async (_e, dir: string, name: string) => {
  if (!insideCaptureRoot(process.env, dir)) {
    throw new Error("refusing to read a path outside the recordings folder");
  }
  if (!/^[A-Za-z0-9._-]+\.png$/.test(name) || name.includes("..")) {
    throw new Error(`refusing to read "${name}"`);
  }
  const buf = await readFile(join(dir, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

/**
 * Store this shot's redaction regions (STC-297) and decoration mode
 * (STC-392 review, I2), so they survive the panel and the app.
 *
 * The renderer sends REGIONS and a MODE, never a document. That is the whole
 * shape of this handler: `shot.json` IS the still — the description is the
 * artefact and the pixels are derived (shot.ts's header) — so letting a
 * sandboxed renderer hand over a replacement document would let it rewrite
 * the display, the crop, the frame's filename and the capture time of a file
 * the app then treats as authoritative. Instead the stored document is read,
 * only the fields the panel is allowed to change are replaced, and the
 * result goes back through `parseShot` before anything is written — so a
 * region the schema would refuse cannot reach the disk, and neither can a
 * document this process did not already have.
 *
 * Widening this channel to carry `mode` alongside `redactions` is still safe
 * under that rule, and it is why the mode never rode along before: `mode` is
 * a closed, low-risk enum — `parseShot` already refuses anything not in
 * `DECORATION_MODES` (and refuses a `WINDOW_MODES` value on a shot that
 * cannot carry it), the same way it already refuses a malformed redaction —
 * so it costs the handler nothing more than the redactions already spend to
 * keep "the renderer may change a shot's decoration and nothing else about
 * it" true. `mode` is optional on the wire (`undefined` keeps the stored
 * value) so a redaction-only call — the undo button, a drawn box — need not
 * repeat a mode nothing about it changed.
 *
 * The write is not atomic and deliberately is not: the alternative is a temp
 * file plus a rename in the take directory, and a half-written `shot.json`
 * from a crash mid-write costs the DECORATION, never the capture — `frame.png`
 * is untouched here and is what the shot actually is.
 */
ipcMain.handle("still:writeShot", async (_e, dir: string, redactions: unknown, mode: unknown) => {
  if (!insideCaptureRoot(process.env, dir)) {
    throw new Error("refusing to write a path outside the recordings folder");
  }
  const file = join(dir, "shot.json");
  const stored = parseShot(JSON.parse(await readFile(file, "utf8")));
  const next = parseShot({
    ...stored,
    decoration: {
      ...stored.decoration,
      redactions,
      ...(mode !== undefined ? { mode } : {}),
    },
  });
  // Through `shotForWrite`, which decides the VERSION: a shot with no
  // annotations stays shot-1 and must not carry the v2-only key, since shot-1
  // declares additionalProperties: false and a document that fails its own
  // schema is the defect this project has now paid for three times.
  await writeFile(file, JSON.stringify(shotForWrite(next), null, 2));
  // The library's cached thumbnail (STC-294) was rendered from the document
  // that just changed, so it now shows a decoration this shot no longer has.
  // Dropped rather than re-rendered: this process has no canvas, and the grid
  // renders a missing one the next time the tile is on screen. A failure here
  // costs a stale picture, never the regions that were just written.
  await rm(join(dir, THUMBNAIL_FILE), { force: true }).catch(() => {});
  return { ok: true, redactions: next.decoration.redactions.length };
});

ipcMain.handle("preview:read", async (e, name: string) => {
  const openTake = getOpenTake(e);
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to read "${name}"`);
  const buf = await readFile(join(openTake, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle("preview:size", async (e, name: string) => {
  const openTake = getOpenTake(e);
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to stat "${name}"`);
  return (await stat(join(openTake, name))).size;
});

/**
 * One slice of a take file.
 *
 * Reading a whole recording in a single IPC message means the buffer exists
 * twice at once — measured at ~949 MB of renderer heap for a 458 MB take — and
 * that peak, not the transfer (835 ms, fast), is what limits how long a take
 * can be. Slices land directly in a destination the renderer allocated once.
 */
ipcMain.handle("preview:chunk", async (e, name: string, offset: number, length: number) => {
  const openTake = getOpenTake(e);
  if (!openTake) throw new Error("no take is open");
  if (!TAKE_FILES.has(name)) throw new Error(`refusing to read "${name}"`);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
    throw new Error("bad chunk range");
  }
  const fh = await open(join(openTake, name), "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  } finally {
    await fh.close();
  }
});

/**
 * Share (STC-242) — the last step of the loop, and the smallest.
 *
 * Three handlers, and between them they are the whole feature: choose the
 * folder in the site repo once, copy the exported MP4 into it under a stable
 * name, and reveal it so the person can see what landed. No upload, no auth,
 * no third-party service — the ticket cut all of that once the destination was
 * decided, and what is left is a file copy that a `git push` in the other repo
 * turns into a published video.
 *
 * Every decision is in `share.ts`; these do the I/O and decide nothing.
 */
ipcMain.handle("share:chooseDestination", async () => {
  if (!win) throw new Error("no window");
  const current = readSettings(app.getPath("userData")).share.destination;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Which folder in the site repo holds the video?",
    properties: ["openDirectory", "createDirectory"],
    ...(current ? { defaultPath: current } : {}),
    buttonLabel: "Choose",
  });
  if (canceled || !filePaths[0]) return { destination: current };
  const destination = filePaths[0];
  const stored = readSettings(app.getPath("userData"));
  writeSettings(app.getPath("userData"), { share: { ...stored.share, destination } });
  return { destination };
});

/**
 * Copy the open take's export into the site folder.
 *
 * **It replaces what is there, and that is the point rather than a hazard
 * overlooked.** The published name comes from the slug, not the take, so the
 * page can embed a fixed path and a re-recorded demo re-publishes over itself
 * — see `DEFAULT_SLUG`. What is owed in exchange is honesty about it: the
 * result says `replaced` when a file was already there, so the UI reports
 * "Replaced" rather than "Wrote" and nobody discovers afterwards that a
 * previous video is gone. It is checked BEFORE the copy, because after it the
 * answer is always yes.
 *
 * No modal confirmation. The destination was chosen by hand, the name comes
 * from a slug the user typed, and replacing that exact file is the entire
 * intended operation — a dialog on every republish would be friction charged
 * for doing what was asked.
 */
ipcMain.handle("share:publish", async (e): Promise<{
  ok: boolean; plan: PublishPlan["kind"]; message?: string;
  file?: string; name?: string; replaced?: boolean; snippet?: string;
}> => {
  const openTake = getOpenTake(e);
  if (!openTake) throw new Error("no take is open");
  const { share } = readSettings(app.getPath("userData"));
  const takeName = basename(openTake);
  const plan = planPublish({
    takeName,
    takeDir: openTake,
    exportExists: existsSync(join(openTake, exportMediaName(takeName))),
    destination: share.destination,
    slug: share.slug,
  });
  if (plan.kind !== "ready") {
    return { ok: false, plan: plan.kind, message: plan.message };
  }
  // Read before the write, or the answer is always "yes, it exists".
  const replaced = existsSync(plan.to);
  await copyFile(plan.from, plan.to);
  // The snippet's dimensions come from the MANIFEST the export wrote beside
  // the video (STC-308), not from the project as it stands now: the project is
  // editable after an export, so reading it here could describe the video as
  // whatever the user has since changed the output to. The manifest records
  // what was actually encoded. Absent or unreadable, the snippet keeps
  // `{width}` unsubstituted rather than inventing a number — a `width="0"`
  // pasted into someone's page is a wrong answer dressed as a real one.
  const size = await exportedSize(openTake, takeName);
  return {
    ok: true, plan: "ready", file: plan.to, name: plan.name, replaced,
    snippet: embedSnippet(share.embedTemplate ?? DEFAULT_EMBED_TEMPLATE, {
      src: publicSrc(share.slug), slug: share.slug, ...size,
    }),
  };
});

/** What the export actually encoded, from its own manifest, or nothing. */
async function exportedSize(dir: string, takeName: string):
    Promise<{ width?: number; height?: number }> {
  try {
    const doc = JSON.parse(await readFile(join(dir, exportManifestName(takeName)), "utf8"));
    const o = doc?.output;
    if (typeof o?.width === "number" && typeof o?.height === "number") {
      return { width: o.width, height: o.height };
    }
  } catch { /* no manifest, or not readable — fall through */ }
  return {};
}

/**
 * Reveal the published file, selected in Finder.
 *
 * `recorder:reveal` shows a take DIRECTORY and refuses anything outside the
 * recordings root, which is right for a take and wrong here: the published
 * file is deliberately outside that root, in the user's own site repo. So this
 * is its own handler with its own rule — it reveals only the exact path the
 * stored destination and slug produce, never a path the renderer names, which
 * is what keeps "open anything you like" from being one IPC call away.
 */
ipcMain.handle("share:reveal", async () => {
  const { share } = readSettings(app.getPath("userData"));
  if (!share.destination) return { ok: false, message: "No site folder chosen yet." };
  const file = join(share.destination, `${share.slug}.mp4`);
  if (!existsSync(file)) return { ok: false, message: "Nothing published yet." };
  shell.showItemInFolder(file);
  return { ok: true, file };
});

ipcMain.handle("recorder:reveal", async (_e, dir: string) => {
  // Only ever reveal something inside the recordings folder: `dir` arrives from
  // the renderer, and the renderer should not be able to open arbitrary paths.
  if (!insideTakesRoot(process.env, dir)) {
    throw new Error("refusing to reveal a path outside the recordings folder");
  }
  shell.showItemInFolder(dir);
});
