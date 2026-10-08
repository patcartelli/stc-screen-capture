/**
 * Renderer RSS while previewing a take, with and without its camera track.
 *
 * PHASE-2 measured "458 MB take -> +548 MB renderer RSS (~1.2x)" for a
 * display-only take, but that measurement was ad hoc and never committed, so
 * the number could not be reproduced when a second decoder arrived. This is
 * the harness, so the next person changing preview memory can re-run it.
 *
 * RSS via app.getAppMetrics(), NEVER performance.memory.usedJSHeapSize —
 * ArrayBuffers live outside V8's heap, so a 458 MB take reported as "~0 MB
 * heap growth". A metric that cannot see the thing being measured produces
 * confident numbers about nothing.
 *
 * GC before every sample that matters (STC-469). The steady-state "after" read
 * used to land in the same tick the raw mic was dropped, before anything had
 * collected it, so a real saving read as ~0. Electron is launched with
 * `--js-flags=--expose-gc`, which Chromium forwards to renderer processes, so
 * the editor page normally has a global `gc()`: `settle()` calls it, waits
 * 1 s, and calls it again. If `gc` is NOT there (a different Electron, a
 * flag that stopped propagating), `settle()` falls back to polling renderer
 * RSS every 500 ms until three consecutive reads sit within 2 MB of each
 * other. It prints which one it used — a number taken without either is not
 * comparable to one taken with them.
 *
 * Runs against master too, by copying this file into a master worktree:
 * `--cleanup` uses the `__stcPreviewAudio` hook where it exists and falls back
 * to the `#previewaudio[data-cleaning]` indicator where it does not.
 * `--export` needs `__stcExportForTest` and so is this branch only; its
 * reuse=false run IS master's export behaviour (decode everything again).
 *
 * Usage: node scripts/measure-preview-memory.mjs <takeDir> [--cleanup] [--export]
 */
import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const root = join(import.meta.dirname, "..");
const src = process.argv[2];
if (!src || !existsSync(join(src, "anchors.json"))) {
  console.error("usage: node scripts/measure-preview-memory.mjs <takeDir> [--cleanup] [--export]");
  process.exit(2);
}

const mb = (bytes) => Math.round(bytes / 1e6);

/** Copies the take into a private recordings dir, optionally stripping the camera. */
function stage(withCamera) {
  const dir = mkdtempSync(join(tmpdir(), "stc-mem-"));
  const takeDir = join(dir, basename(src));
  mkdirSync(takeDir, { recursive: true });
  const files = ["anchors.json", "events.json", "display.mp4", "project.json", "mic.m4a", "system.m4a"];
  if (withCamera) files.push("camera.mp4");
  for (const f of files) {
    if (existsSync(join(src, f))) cpSync(join(src, f), join(takeDir, f));
  }
  if (!withCamera) {
    // The anchors must agree with the directory: loadSession refuses a claimed
    // camera with no file, which is the whole point of that check.
    const a = JSON.parse(readFileSync(join(takeDir, "anchors.json"), "utf8"));
    if (a.camera) a.camera.present = false;
    if (a.files) delete a.files.camera;
    writeFileSync(join(takeDir, "anchors.json"), JSON.stringify(a, null, 2));
    const pPath = join(takeDir, "project.json");
    if (existsSync(pPath)) {
      const p = JSON.parse(readFileSync(pPath, "utf8"));
      if (p.pip) p.pip.enabled = false;
      writeFileSync(pPath, JSON.stringify(p, null, 2));
    }
  }
  let bytes = 0;
  for (const f of files) if (existsSync(join(takeDir, f))) bytes += statSync(join(takeDir, f)).size;
  return { dir, bytes };
}

/** Renderer RSS in bytes. getAppMetrics reports memory in KILOBYTES. */
async function rendererRss(app) {
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const renderers = metrics.filter((m) => m.type === "Tab" || m.type === "Renderer");
  return renderers.reduce((n, m) => n + (m.memory?.workingSetSize ?? 0) * 1024, 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Let the renderer drop what it no longer references before a sample: a
 * forced GC when the page has `gc()`, otherwise wait for RSS to stop moving.
 * Returns how it settled, for the printout.
 */
async function settle(app, page) {
  const hasGc = await page.evaluate(() => typeof globalThis.gc === "function");
  if (hasGc) {
    await page.evaluate(() => globalThis.gc());
    await sleep(1000);
    await page.evaluate(() => globalThis.gc());
    return "gc";
  }
  const reads = [await rendererRss(app)];
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    reads.push(await rendererRss(app));
    const last3 = reads.slice(-3);
    if (last3.length === 3 && Math.max(...last3) - Math.min(...last3) <= 2e6) return "rss-stable";
  }
  return "rss-unstable (60 s)";
}

async function measure(withCamera) {
  const { dir, bytes } = stage(withCamera);
  // A throwaway profile, exactly as app/test/_editor-fixture.ts launches the
  // app: since STC-412 a real profile's `saveFolder` OVERRIDES
  // STC_RECORDINGS_DIR, so without this the run opens the first take in the
  // user's real library — and toggling cleanup would write its project.json.
  const userData = mkdtempSync(join(tmpdir(), "stc-mem-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ saveFolder: null }));
  const app = await electron.launch({
    args: ["--js-flags=--expose-gc", root, `--user-data-dir=${userData}`], cwd: root,
    env: {
      ...process.env, STC_RECORDINGS_DIR: dir,
      // Same isolation as the fixture: never the real temp-takes folder.
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-mem-temp-")),
      // STC-502: launch shows no window unless asked.
      STC_OPEN_LIBRARY_ON_LAUNCH: "1",
    },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await win.waitForSelector("#takes >> text=Preview", { timeout: 30_000 });
    const before = await rendererRss(app);

    // The preview became its own window in STC-373 — it no longer opens
    // in-page as #player in the main window, so Preview opens a second
    // BrowserWindow and the pixel check runs against ITS #stage. Filter on
    // the URL rather than taking the first "window" event: on a machine with
    // no helper permissions the supervisor can pop a toast window (e.g. "the
    // recorder keeps failing to start") that races the editor window and
    // would otherwise be mistaken for it. The predicate must pick out the
    // VIDEO editor specifically — a bare `includes("editor.html")` would also
    // match `still-editor.html`.
    const [editorWin] = await Promise.all([
      app.waitForEvent("window", {
        predicate: (p) => /\/editor\.html(\?|#|$)/.test(p.url()),
        timeout: 60_000,
      }),
      win.click("#takes >> text=Preview"),
    ]);
    await editorWin.waitForLoadState("domcontentloaded");
    // Wait for real pixels: RSS read before decoding starts measures nothing.
    await editorWin.waitForFunction(() => {
      const c = document.getElementById("stage");
      if (!c) return false;
      // The CENTRE, not the corner: a corner can be legitimately dark (a
      // dark menu bar, a letterbox) and then this waits forever.
      const d = c.getContext("2d").getImageData((c.width >> 1) - 16, (c.height >> 1) - 16, 32, 32).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 24) return true;
      return false;
    // `null` is the page-function ARG: options are the third parameter. Passed
    // second, the timeout was silently Playwright's 30 s default — too short
    // once a long take's audio has to be read and demuxed first (STC-469).
    }, null, { timeout: 180_000 });

    // STC-469: the audio is part of what the preview holds. Wait for it to
    // decode, turn cleanup on if asked, and wait for the cleaned mic to play.
    await editorWin.waitForFunction(() => {
      const s = document.getElementById("previewaudio")?.dataset.state;
      return s && s !== "loading";
    }, null, { timeout: 600_000 });
    if (process.argv.includes("--cleanup")) {
      const state = await editorWin.getAttribute("#previewaudio", "data-state");
      if (state !== "ready") {
        throw new Error(`--cleanup needs a take whose preview audio is "ready"; #previewaudio is "${state}"`);
      }
      const hasHook = await editorWin.evaluate(() => typeof (window).__stcPreviewAudio === "function");
      if (!hasHook) {
        // master: no hook. The indicator goes "true" when cleaning starts and
        // "false" when the cleaned mic lands; observe from BEFORE the click so
        // a fast clean cannot flip both ways unseen.
        await editorWin.evaluate(() => {
          const b = document.getElementById("previewaudio");
          new MutationObserver(() => { if (b.dataset.cleaning === "true") (window).__memSawCleaning = true; })
            .observe(b, { attributes: true, attributeFilter: ["data-cleaning"] });
        });
      }
      await editorWin.click("#audiobtn");
      await editorWin.locator("#voicecleanon").check();
      await editorWin.keyboard.press("Escape");
      if (hasHook) {
        await editorWin.waitForFunction(() => (window).__stcPreviewAudio().playing === "cleaned", null, { timeout: 600_000 });
      } else {
        await editorWin.waitForFunction(
          () => (window).__memSawCleaning === true && document.getElementById("previewaudio").dataset.cleaning === "false",
          null, { timeout: 600_000 });
      }
    }

    const settledBy = await settle(app, editorWin);
    const after = await rendererRss(app);
    console.log(`  steady state settled by: ${settledBy}`);
    if (process.argv.includes("--export")) {
      for (const reuse of [false, true]) {
        await settle(app, editorWin);
        const start = await rendererRss(app);
        let peak = start;
        let inFlight = Promise.resolve();
        const timer = setInterval(() => {
          inFlight = inFlight.then(async () => { peak = Math.max(peak, await rendererRss(app)); });
        }, 250);
        try {
          await editorWin.evaluate((reuse) => (window).__stcExportForTest({ reuse }), reuse);
        } finally {
          clearInterval(timer);
          await inFlight;
        }
        const end = await rendererRss(app);
        peak = Math.max(peak, end);
        console.log(`  export (reuse=${reuse}): renderer RSS ${mb(start)} MB before, peak ${mb(peak)} MB (+${mb(peak - start)}), ${mb(end)} MB after`);
      }
    }
    return { bytes, before, after, growth: after - before };
  } finally {
    await app.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

execFileSync("node", [join(root, "app", "build.mjs")], { cwd: root, stdio: "pipe" });

const off = await measure(false);
const on = await measure(true);

const row = (label, r) =>
  `${label.padEnd(16)} ${String(mb(r.bytes) + " MB").padEnd(10)} ` +
  `${String(mb(r.before) + " -> " + mb(r.after) + " MB").padEnd(20)} ` +
  `+${mb(r.growth)} MB  (${(r.growth / r.bytes).toFixed(2)}x file)`;

console.log(`\ntake: ${src}`);
console.log(`${"".padEnd(16)} ${"files".padEnd(10)} ${"renderer RSS".padEnd(20)} growth`);
console.log(row("display only", off));
console.log(row("display+camera", on));
const extra = on.growth - off.growth;
const dBytes = statSync(join(src, "display.mp4")).size;
const cBytes = existsSync(join(src, "camera.mp4")) ? statSync(join(src, "camera.mp4")).size : 0;
console.log(`\ndisplay.mp4 ${mb(dBytes)} MB, camera.mp4 ${mb(cBytes)} MB`);
console.log(
  `camera track costs +${mb(extra)} MB of renderer RSS ` +
  `(${((extra / off.growth) * 100).toFixed(0)}% on top of display-only)`,
);

// Read the ratio in the right regime before quoting it anywhere.
//
// PHASE-2's "~1.2x file size" came from a 458 MB take, where the file itself
// dominates. On a SHORT take the fixed costs — decoder buffers and a decoded
// 4K frame at ~30 MB — dominate instead, so the ratio looks far worse while
// the absolute numbers are small. The two are not comparable, and the ceiling
// in STC-251 is about the long regime.
//
// The design spec's open risk guessed "a 720p camera adds ~10-15%". That guess
// assumed the display track dwarfs the camera. Check whether it actually does
// here before treating any percentage as a verdict.
if (cBytes >= dBytes) {
  console.log(
    `\nNOTE: camera.mp4 is ${(cBytes / dBytes).toFixed(1)}x the size of display.mp4 on this take, ` +
    `so the percentage above says more about the two FILES than about PiP overhead. ` +
    `The spec's 10-15% estimate assumed a display track that dwarfs the camera — ` +
    `which is a long 4K take, not this one.`,
  );
}
console.log(
  `\nRatios are regime-dependent: PHASE-2's ~1.2x came from a 458 MB take where the ` +
  `file dominates. This take is ${mb(off.bytes + cBytes)} MB, where fixed decoder cost does. ` +
  `Quote the absolute growth, not the multiple.`,
);
