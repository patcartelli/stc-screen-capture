import { describe, test, expect, afterEach } from "vitest";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTakeFolder } from "./_take-fixture.js";
import { PRODUCT_NAME, LEGACY_APP_DIR_NAME } from "../src/product.js";
import { closeApp, APP_CLOSE_MS } from "./_quit-fixture.js";

/**
 * Settings survive the rename to Capture (STC-397).
 *
 * The ticket's own third acceptance line — "existing settings and takes still
 * present after the rename" — and the one part of this change that can
 * actually destroy something a user cares about. `productName` moves
 * `app.getPath("userData")`, so a real configuration (camera, mic, four
 * custom hotkeys, the save folder and share destination) is left in a folder
 * the renamed app no longer reads. The seeded fixture below still writes the
 * pre-STC-412 `still.destination` shape deliberately — it stands in for a
 * REAL legacy settings.json written before that field moved to the top-level
 * `saveFolder`, and the migration copies the file wholesale regardless of its
 * shape, so this needs no functional change: `readSettings` simply ignores
 * the now-unknown key on the far side, same as it ignores any other one.
 *
 * Driven through the REAL app rather than by calling the migration directly,
 * because the property under test is an ORDERING one: the migration has to
 * run before the first `readSettings`, and a unit test of the function alone
 * would pass just as well if it were wired in too late to matter. The
 * assertion is on what the app REPORTS its settings to be — through the same
 * `recorder:getSettings` the UI uses — not merely on a file appearing.
 *
 * `--user-data-dir` is what makes this testable at all: the migration
 * resolves the legacy folder as a SIBLING of the current one (Electron
 * already knows where user data lives on this platform), so pointing the app
 * at `<tmp>/Capture` makes `<tmp>/stc-screen-recorder` its legacy folder.
 */
const root = join(__dirname, "..", "..");
const FAKE_HELPER = join(root, "app", "test", "_fake-helper.mjs");

let app: ElectronApplication | undefined;
afterEach(async () => { const a = app; app = undefined; await closeApp(a); }, APP_CLOSE_MS);

/** A pre-rename Application Support folder, with a real settings.json in it. */
function seedLegacy(settings: Record<string, unknown>): { base: string; userData: string; legacy: string } {
  const base = mkdtempSync(join(tmpdir(), "stc-rename-"));
  const userData = join(base, PRODUCT_NAME);
  const legacy = join(base, LEGACY_APP_DIR_NAME);
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "settings.json"), JSON.stringify(settings, null, 2));
  return { base, userData, legacy };
}

async function launch(userData: string) {
  app = await electron.launch({
    args: [root, `--user-data-dir=${userData}`],
    cwd: root,
    env: {
      ...process.env,
      STC_RECORDINGS_DIR: makeTakeFolder().dir,
      STC_TEMP_TAKES_DIR: mkdtempSync(join(tmpdir(), "stc-temp-")),
      STC_HELPER_BIN: FAKE_HELPER,
      STC_NO_SHUTTER: "1",
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  return win;
}

describe("settings survive the rename to Capture (STC-397)", () => {
  test("a pre-rename settings.json is carried across and actually read", async () => {
    // Deliberately NOT the defaults — every one of these would read as a
    // pass if the migration silently did nothing and the app fell back.
    const { userData, legacy } = seedLegacy({
      camera: true,
      shortcuts: { region: "Control+Alt+Shift+Command+7" },
      still: { format: "heic", quality: 0.5, scale: "native",
               stripMetadata: true, template: "{app}", destination: null },
      thumbnail: { corner: "top-left", skip: true },
    });
    const win = await launch(userData);

    const settings = await win.evaluate(() => (window as any).recorder.getSettings());
    expect(settings.camera).toBe(true);
    expect(settings.shortcuts.region).toBe("Control+Alt+Shift+Command+7");
    expect(settings.still.format).toBe("heic");
    expect(settings.still.stripMetadata).toBe(true);
    expect(settings.thumbnail.corner).toBe("top-left");
    expect(settings.thumbnail.skip).toBe(true);

    // On disk in the new home too, so the NEXT launch needs no migration.
    expect(existsSync(join(userData, "settings.json"))).toBe(true);
    // And COPIED, not moved: a rollback to the pre-rename build must still
    // find its own settings where it left them.
    expect(existsSync(join(legacy, "settings.json"))).toBe(true);
  }, 60_000);

  test("settings written AFTER the rename are never clobbered by the stale copy", async () => {
    // The migration runs on every launch, so the second launch must not
    // undo what the first one's user did. This is the idempotence that makes
    // "runs unconditionally at startup" safe rather than destructive.
    const { userData, legacy } = seedLegacy({ thumbnail: { corner: "top-left" } });

    const win = await launch(userData);
    await win.evaluate(() => (window as any).recorder.setSettings(
      { thumbnail: { corner: "bottom-right", skip: true } }));
    await app!.close();
    app = undefined;

    // The legacy copy still says top-left; the new one says otherwise.
    expect(JSON.parse(readFileSync(join(legacy, "settings.json"), "utf8")).thumbnail.corner)
      .toBe("top-left");

    const win2 = await launch(userData);
    const settings = await win2.evaluate(() => (window as any).recorder.getSettings());
    expect(settings.thumbnail.corner).toBe("bottom-right");
    expect(settings.thumbnail.skip).toBe(true);
  }, 90_000);

  test("a fresh install with no legacy folder starts on defaults, not an error", async () => {
    const base = mkdtempSync(join(tmpdir(), "stc-rename-fresh-"));
    const win = await launch(join(base, PRODUCT_NAME));
    const settings = await win.evaluate(() => (window as any).recorder.getSettings());
    // Whatever the defaults are, the app came up and answered — the point is
    // that a missing legacy folder is the normal case, not a failure.
    expect(settings).toBeTruthy();
    expect(settings.thumbnail).toBeTruthy();
  }, 60_000);
});
