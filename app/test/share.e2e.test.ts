import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { autoSlug, exportManifestName, exportMediaName } from "../src/share.js";
import { openEditorFromLibrary, inkiness } from "./_editor-fixture.js";
import { mintCaptureId } from "@transform/capture-id.js";
import { CAPTURE_DOC_FILE, captureDocForWrite } from "@transform/capture-doc.js";
import { tagMp4 } from "@transform/media-tag.js";

/**
 * STC-242 — share, end to end through the real handlers.
 *
 * `share.test.ts` covers every decision; this covers the wiring those
 * decisions hang off, which is where the bugs that survive unit tests live: a
 * handler that reads the wrong settings block, a preload method wired to the
 * wrong channel, a copy that lands somewhere other than where the plan said.
 *
 * Share moved to the editor's own window and bridge with the rest of the
 * player (STC-373) — `publish`/`revealPublished` are driven through
 * `window.editor` in the EDITOR window now, not `window.recorder` in the
 * main one. `setSettings` stays on the main window's bridge, since general
 * preferences did not move.
 *
 * STC-444 slice 3: the slug moved off `settings.share` and onto each take's
 * own `project.json` (`Project.slug`). `launch()` below seeds it there
 * directly rather than through the editor's UI, the same reasoning
 * `nothing-lost.e2e.test.ts` seeds `saveFolder` on disk instead of walking a
 * picker no automated test can answer.
 */
const root = join(__dirname, "..", "..");
let app: ElectronApplication | undefined;
afterEach(async () => { await app?.close().catch(() => {}); app = undefined; });

const TAKE = "2026-08-24_10-00-00";

interface Launched {
  win: Page; editorWin: Page; recordings: string; takeDir: string; site: string;
  /** The bytes seeded as this take's export, when `withExport` — for asserting the copy is exact. */
  exportedBytes?: Buffer;
}

/**
 * A structurally valid, tiny MP4 `tagMp4` can actually tag (STC-413) — a
 * plain string of bytes is not, and `tagMp4` REFUSES rather than corrupts
 * anything it cannot parse, which would silently leave the seeded file
 * carrying no id at all. `export-write-guard.e2e.test.ts` uses the identical
 * shape.
 */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chars = (s: string) => [...s].map((c) => c.charCodeAt(0));
const box = (type: string, data: number[]) => [...be32(8 + data.length), ...chars(type), ...data];
function mp4Bytes(): Uint8Array {
  return new Uint8Array([...box("ftyp", chars("isom")), ...box("mdat", [1, 2, 3, 4]),
    ...box("moov", [])]);
}

/**
 * The site folder is seeded on DISK rather than chosen through the picker.
 *
 * `share:chooseDestination` opens a native folder dialog, which no automated
 * test can answer — the same reason `nothing-lost.e2e.test.ts` seeds
 * `saveFolder` (STC-412's field, `still.destination`'s replacement). What is
 * under test is what happens with a destination configured, not the dialog.
 */
async function launch(opts: { withExport?: boolean; slug?: string | null } = {}): Promise<Launched> {
  const { dir: recordings, takeDir } = makeTakeFolder(TAKE);
  const site = mkdtempSync(join(tmpdir(), "stc-site-"));
  const userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
  writeFileSync(join(userData, "settings.json"), JSON.stringify({
    share: { destination: site },
  }));
  // STC-444 slice 3: the slug is per-take now. `slug: null` tests the
  // fallback path (a take whose project.json was never written, or never
  // touched the field) — every other case seeds an explicit one so the
  // existing "network.mp4" assertions below stay meaningful regardless of
  // what `autoSlug` would make of this fixture's timestamp-shaped name.
  if (opts.slug !== null) {
    writeFileSync(join(takeDir, "project.json"), JSON.stringify({
      version: 7,
      output: { fps: 60, width: 1920, height: 1080 },
      cursor: { style: "default", scale: 1 },
      transform: { version: 1 },
      slug: opts.slug ?? "network",
    }));
  }
  let exportedBytes: Buffer | undefined;
  if (opts.withExport !== false) {
    // Stand in for a real export. STC-413: `share:publish` resolves its
    // source by the BUNDLE's own identity, so the fake export has to carry
    // the SAME id the bundle's `capture.json` names — a stray id would leave
    // the two unmatched and publish would (correctly) report no export.
    // A real export lands at the TOP LEVEL of the folder now, a sibling of
    // the bundle rather than something inside it.
    const id = mintCaptureId();
    writeFileSync(join(takeDir, CAPTURE_DOC_FILE), JSON.stringify(captureDocForWrite(id)));
    exportedBytes = Buffer.from(tagMp4(mp4Bytes(), id));
    writeFileSync(join(recordings, exportMediaName(TAKE)), exportedBytes);
    writeFileSync(join(takeDir, exportManifestName(TAKE)), JSON.stringify({
      version: 1, output: { fps: 60, width: 1920, height: 1080 },
    }));
  }
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`], cwd: root,
    env: { ...process.env, STC_RECORDINGS_DIR: recordings, STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")), },
  });
  const mainWin = await app.firstWindow();
  await mainWin.waitForLoadState("domcontentloaded");
  await mainWin.waitForSelector("#takes >> text=Preview", { timeout: 20_000 });
  // Publishing acts on the take the EDITOR has open (STC-373) — opening it is
  // what makes there be one.
  const editorWin = await openEditorFromLibrary(app, mainWin);
  await expect.poll(() => inkiness(editorWin), { timeout: 30_000 }).toBeGreaterThan(0.2);
  return { win: mainWin, editorWin, recordings, takeDir, site, exportedBytes };
}

const publish = (win: Page) => win.evaluate(() => (window as any).editor.publish());

describe("share to the site folder", () => {
  test("copies the export under the SLUG's name, not the take's", async () => {
    const { editorWin, site, exportedBytes } = await launch();
    const r = await publish(editorWin);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.name).toBe("network.mp4");
    // The whole point: the published name carries no timestamp, so the page
    // can embed a fixed path across re-recordings.
    expect(r.name).not.toContain(TAKE);
    expect(existsSync(join(site, "network.mp4"))).toBe(true);
    expect(readFileSync(join(site, "network.mp4"))).toEqual(exportedBytes);
    // First publish into an empty folder replaced nothing, and says so.
    expect(r.replaced).toBe(false);
  }, 60_000);

  /**
   * The fallback path: a take that has never written a `project.json` at
   * all still publishes, under a name derived from its OWN folder name —
   * `main.ts`'s `readProjectSlug` falling through to `autoSlug`, not a
   * refusal for a take that simply hasn't opened the export dialog yet.
   * `autoSlug`, not the raw take name: TAKE's underscore is not itself a
   * valid slug character, so the published name is not literally
   * `${TAKE}.mp4` — `share.test.ts` covers that transform on its own.
   */
  test("a take with no project.json yet still publishes, under its own name", async () => {
    const { editorWin, site } = await launch({ slug: null });
    const r = await publish(editorWin);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.name).toBe(`${autoSlug(TAKE)}.mp4`);
    expect(existsSync(join(site, `${autoSlug(TAKE)}.mp4`))).toBe(true);
  }, 60_000);

  /**
   * Re-publishing overwrites, deliberately — and REPORTS it.
   *
   * The overwrite is the design (one stable path per demo, so a re-shoot needs
   * no page edit). Being quiet about it is not: someone who did not expect it
   * should learn from the app rather than from `git status`.
   */
  test("re-publishing replaces, and says that it replaced", async () => {
    const { editorWin, site, exportedBytes } = await launch();
    expect((await publish(editorWin)).replaced).toBe(false);
    writeFileSync(join(site, "network.mp4"), Buffer.from("older-video"));
    const second = await publish(editorWin);
    expect(second.ok).toBe(true);
    expect(second.replaced).toBe(true);
    expect(readFileSync(join(site, "network.mp4"))).toEqual(exportedBytes);
  }, 60_000);

  test("refuses, with the reason, when the take has not been exported", async () => {
    const { editorWin, site } = await launch({ withExport: false });
    const r = await publish(editorWin);
    expect(r.ok).toBe(false);
    expect(r.plan).toBe("no-export");
    expect(r.message).toMatch(/export/i);
    // Nothing was written on a refusal — a failed publish must not leave a
    // partial file the site would then serve.
    expect(existsSync(join(site, "network.mp4"))).toBe(false);
  }, 60_000);

  test("offers a snippet carrying the dimensions the export actually encoded", async () => {
    const { editorWin } = await launch();
    const r = await publish(editorWin);
    expect(r.snippet).toContain("src: '/lab/videos/network.mp4'");
    // 1920x1080 comes from the MANIFEST, not from the project as it now
    // stands — the project is editable after an export.
    expect(r.snippet).toContain("width: 1920");
    expect(r.snippet).toContain("height: 1080");
  }, 60_000);

  test("with no manifest, the snippet says so rather than pasting a zero", async () => {
    const { editorWin, takeDir } = await launch();
    writeFileSync(join(takeDir, exportManifestName(TAKE)), "not json");
    const r = await publish(editorWin);
    expect(r.ok).toBe(true);
    expect(r.snippet).toContain("{width}");
    expect(r.snippet).not.toContain('width="0"');
  }, 60_000);

  test("reveal reports honestly when nothing has been published this session", async () => {
    const { editorWin } = await launch();
    const r = await editorWin.evaluate(() => (window as any).editor.revealPublished());
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/nothing published/i);
  }, 60_000);

  /**
   * "Show published" folded into publish's own success feedback (STC-444
   * slice 3) — there is no standing reveal button any more, so this is the
   * only way `share:reveal` can now say `ok: true`: the exact path a
   * publish in THIS session just wrote to, remembered in-process rather
   * than re-derived from settings (there is no global slug left to derive
   * it from).
   */
  test("reveal succeeds after a publish, with the exact path just written", async () => {
    const { editorWin, site } = await launch();
    const published = await publish(editorWin);
    expect(published.ok).toBe(true);
    const r = await editorWin.evaluate(() => (window as any).editor.revealPublished());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.file).toBe(join(site, "network.mp4"));
  }, 60_000);

  /**
   * The main-side guard, reached through the IPC rather than the UI.
   *
   * `recorder:setSettings` strips `share.destination` so the renderer cannot
   * make this process copy a file to a path of its choosing — the same rule
   * `saveFolder` already follows (STC-412, `still.destination`'s successor).
   * STC-292's lesson is that testing this through the preferences UI would
   * prove nothing: whichever guard is met
   * first is the only one exercised, and a renderer-side check would satisfy
   * the assertion with main's own guard removed. `setSettings` is the main
   * window's own bridge method — it did not move to the editor.
   */
  test("the renderer cannot set the site folder through setSettings", async () => {
    const { win, site } = await launch();
    const after = await win.evaluate(() => (window as any).recorder.setSettings({
      share: { destination: "/tmp/somewhere-else" },
    }));
    expect(after.share.destination).toBe(site);
  }, 60_000);
});

/**
 * The export dialog's own Share row, driven through real clicks and typing —
 * `describe("share to the site folder")` above calls `editor.publish()`
 * directly and never touches `#shareslug`, so it cannot catch a bug in the
 * dialog's OWN wiring: the field showing the wrong prefill, a click not
 * persisting before publishing, the reveal button staying hidden after a
 * real success.
 */
describe("the export dialog's Share row", () => {
  test("prefills the slug from the take's own name when never published", async () => {
    const { editorWin } = await launch({ slug: null });
    await editorWin.click("#openexport");
    await expect.poll(() => editorWin.inputValue("#shareslug"), { timeout: 10_000 })
      .toBe(autoSlug(TAKE));
  }, 60_000);

  test("prefills the slug from the project when it has one", async () => {
    const { editorWin } = await launch({ slug: "login-bug" });
    await editorWin.click("#openexport");
    await expect.poll(() => editorWin.inputValue("#shareslug"), { timeout: 10_000 })
      .toBe("login-bug");
  }, 60_000);

  test("shows the configured site folder, read-only", async () => {
    const { editorWin, site } = await launch();
    await editorWin.click("#openexport");
    await expect.poll(() => editorWin.textContent("#sitedestnote"), { timeout: 10_000 })
      .toContain(site);
  }, 60_000);

  test("typing a custom slug and clicking Share persists and publishes under it", async () => {
    const { editorWin, site } = await launch({ slug: null });
    await editorWin.click("#openexport");
    await editorWin.fill("#shareslug", "login-bug");
    await editorWin.click("#share");
    await expect.poll(() => editorWin.textContent("#sharestatus"), { timeout: 15_000 })
      .toMatch(/Wrote|Replaced/);
    expect(existsSync(join(site, "login-bug.mp4"))).toBe(true);
    expect(existsSync(join(site, `${TAKE}.mp4`))).toBe(false);
  }, 60_000);

  test("Show in Finder appears only after a publish succeeds, from this row alone", async () => {
    const { editorWin } = await launch();
    await editorWin.click("#openexport");
    expect(await editorWin.isHidden("#sharereveal")).toBe(true);
    await editorWin.click("#share");
    await expect.poll(() => editorWin.isVisible("#sharereveal"), { timeout: 15_000 }).toBe(true);
  }, 60_000);

  test("a bad slug is refused without persisting or publishing anything", async () => {
    const { editorWin, site } = await launch({ slug: null });
    await editorWin.click("#openexport");
    await editorWin.fill("#shareslug", "Not A Slug");
    await editorWin.click("#share");
    await expect.poll(() => editorWin.textContent("#sharestatus"), { timeout: 10_000 })
      .toMatch(/not a usable name/i);
    expect(existsSync(join(site, "not-a-slug.mp4"))).toBe(false);
    expect(existsSync(join(site, `${TAKE}.mp4`))).toBe(false);
  }, 60_000);
});
