import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  tempTakesRoot, insideTempTakesRoot, newTempTakeDir, promoteTake,
  purgeStaleTempTakes, listTempTakes, TEMP_TAKE_MAX_AGE_MS,
  legacyTempTakesRoot, migrateLegacyTempTakes,
} from "../src/temp-takes.js";
import { PRODUCT_NAME, LEGACY_APP_DIR_NAME } from "../src/product.js";

describe("where a capture lives before it is saved (STC-393)", () => {
  test("defaults to Application Support, not Caches — the OS must not sweep a live recording", () => {
    // Named for the PRODUCT (STC-397), so this root moves with `userData`
    // rather than sitting in a folder named after the old product forever.
    expect(tempTakesRoot({})).toBe(
      join(homedir(), "Library", "Application Support", PRODUCT_NAME, "temp-takes"));
  });

  test("STC_TEMP_TAKES_DIR overrides it, so tests need not litter a real Application Support", () => {
    expect(tempTakesRoot({ STC_TEMP_TAKES_DIR: "/somewhere/else" })).toBe("/somewhere/else");
  });

  test("named the same way a library take is — one naming rule, two roots", () => {
    const at = new Date(2026, 8, 16, 10, 5, 30);
    expect(newTempTakeDir({ STC_TEMP_TAKES_DIR: "/t" }, at))
      .toBe(join("/t", "2026-09-16_10-05-30"));
    const a = newTempTakeDir({ STC_TEMP_TAKES_DIR: "/t" }, at);
    const b = newTempTakeDir({ STC_TEMP_TAKES_DIR: "/t" }, at, ["2026-09-16_10-05-30"]);
    expect(b).not.toBe(a);
    expect(b).toMatch(/2026-09-16_10-05-30-2$/);
  });
});

/**
 * Carrying unsaved takes across the rename to Capture (STC-397).
 *
 * The move itself is `moveDir`, which `promoteTake`'s own tests above already
 * exercise against real directories. What is worth pinning here is the part
 * that is specific to a MIGRATION and easy to get quietly wrong: that it
 * knows which two folders it is bridging, and — the load-bearing one — that
 * it refuses to run at all under `STC_TEMP_TAKES_DIR`, so a test's fresh
 * temp root can never be handed the real user's leftovers.
 */
describe("migrating unsaved takes across the rename (STC-397)", () => {
  test("the legacy root is the pre-rename folder, and it is NOT the current one", () => {
    expect(legacyTempTakesRoot()).toBe(
      join(homedir(), "Library", "Application Support", LEGACY_APP_DIR_NAME, "temp-takes"));
    // If these ever coincided the migration would be vacuous, and every test
    // below would pass while proving nothing.
    expect(legacyTempTakesRoot()).not.toBe(tempTakesRoot({}));
    expect(PRODUCT_NAME).not.toBe(LEGACY_APP_DIR_NAME);
  });

  test("does nothing at all when STC_TEMP_TAKES_DIR is set — a test root is never given real leftovers", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "stc-migrate-"));
    try {
      expect(await migrateLegacyTempTakes({ STC_TEMP_TAKES_DIR: isolated })).toBe(0);
      // Untouched: nothing was created inside it and nothing was moved in.
      expect(readdirSync(isolated)).toEqual([]);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });
});

describe("insideTempTakesRoot", () => {
  const env = { STC_TEMP_TAKES_DIR: "/temp" } as NodeJS.ProcessEnv;

  test("a take inside the temp root is accepted", () => {
    expect(insideTempTakesRoot(env, "/temp/2026-09-16_10-00-00")).toBe(true);
  });

  test("traversal, a sibling folder, the root itself and a non-path are all refused", () => {
    expect(insideTempTakesRoot(env, "/temp/../../etc")).toBe(false);
    expect(insideTempTakesRoot(env, "/temp-other")).toBe(false);
    expect(insideTempTakesRoot(env, "/temp")).toBe(false);
    expect(insideTempTakesRoot(env, "")).toBe(false);
    expect(insideTempTakesRoot(env, undefined as never)).toBe(false);
  });

  test("a library take is not a temp take", () => {
    expect(insideTempTakesRoot(env, "/some/other/root/2026-09-16_10-00-00")).toBe(false);
  });
});

describe("promoteTake — the decision point", () => {
  let tempRoot: string;
  let libRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "stc-promote-"));
    tempRoot = join(base, "temp");
    libRoot = join(base, "lib");
    mkdirSync(tempRoot, { recursive: true });
    env = { STC_TEMP_TAKES_DIR: tempRoot, STC_RECORDINGS_DIR: libRoot };
  });
  afterEach(() => { rmSync(join(tempRoot, ".."), { recursive: true, force: true }); });

  function makeTempTake(name: string, files: Record<string, string> = { "shot.json": "{}" }) {
    const dir = join(tempRoot, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, contents] of Object.entries(files)) writeFileSync(join(dir, f), contents);
    return dir;
  }

  test("moves the whole directory into the library, keeping its own name", async () => {
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, null, dir);
    expect(dest).toBe(join(libRoot, "2026-09-16_10-00-00"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dest, "shot.json"))).toBe(true);
  });

  test("creates the library root if this is the first promotion ever", async () => {
    rmSync(libRoot, { recursive: true, force: true });
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, null, dir);
    expect(existsSync(dest)).toBe(true);
  });

  test("a name collision in the library gets the same -2 suffix newTakeDir would give it", async () => {
    mkdirSync(join(libRoot, "2026-09-16_10-00-00"), { recursive: true });
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, null, dir);
    expect(dest).toBe(join(libRoot, "2026-09-16_10-00-00-2"));
  });

  test("a dir already outside the temp root is returned unchanged — idempotent for a caller that already promoted it", async () => {
    const already = join(libRoot, "2026-09-16_10-00-00");
    mkdirSync(already, { recursive: true });
    expect(await promoteTake(env, null, already)).toBe(already);
    expect(existsSync(already)).toBe(true);
  });

  test("a bare path with no configured temp root (e.g. a test's own tmpdir) is left alone", async () => {
    // Exactly the shape `supervisor.test.ts` exercises: a session directory
    // that is real but nowhere near the temp root promoteTake is watching.
    const bare = mkdtempSync(join(tmpdir(), "stc-bare-"));
    expect(await promoteTake({}, null, bare)).toBe(bare);
    expect(existsSync(bare)).toBe(true);
    rmSync(bare, { recursive: true, force: true });
  });

  test("a chosen saveFolder (STC-412) wins over STC_RECORDINGS_DIR as the promotion target", async () => {
    const chosen = join(tempRoot, "..", "chosen");
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, chosen, dir);
    expect(dest).toBe(join(chosen, "2026-09-16_10-00-00"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dest, "shot.json"))).toBe(true);
    // ...and NOT the env-derived library root.
    expect(existsSync(join(libRoot, "2026-09-16_10-00-00"))).toBe(false);
  });
});

describe("purgeStaleTempTakes", () => {
  let tempRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "stc-purge-"));
    env = { STC_TEMP_TAKES_DIR: tempRoot };
  });
  afterEach(() => { rmSync(tempRoot, { recursive: true, force: true }); });

  test("removes a take older than 7 days, going by its OWN timestamped name", async () => {
    const stale = join(tempRoot, "2020-01-01_00-00-00");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "shot.json"), "{}");
    const now = new Date("2026-09-16T00:00:00").getTime();
    const purged = await purgeStaleTempTakes(env, now);
    expect(purged).toEqual(["2020-01-01_00-00-00"]);
    expect(existsSync(stale)).toBe(false);
  });

  test("a take younger than 7 days survives", async () => {
    const now = new Date("2026-09-16T12:00:00").getTime();
    const recent = join(tempRoot, "2026-09-15_12-00-00");
    mkdirSync(recent, { recursive: true });
    const purged = await purgeStaleTempTakes(env, now);
    expect(purged).toEqual([]);
    expect(existsSync(recent)).toBe(true);
  });

  test("exactly at the boundary is purged; one millisecond short survives", async () => {
    const at = new Date("2026-09-01T00:00:00").getTime();
    const name = "2026-09-01_00-00-00";
    mkdirSync(join(tempRoot, name), { recursive: true });
    expect(await purgeStaleTempTakes(env, at + TEMP_TAKE_MAX_AGE_MS - 1)).toEqual([]);
    expect(await purgeStaleTempTakes(env, at + TEMP_TAKE_MAX_AGE_MS)).toEqual([name]);
  });

  test("a directory this module did not name falls back to mtime", async () => {
    const weird = join(tempRoot, "not-a-stamp");
    mkdirSync(weird, { recursive: true });
    const old = Date.now() - TEMP_TAKE_MAX_AGE_MS - 60_000;
    utimesSync(weird, old / 1000, old / 1000);
    const purged = await purgeStaleTempTakes(env, Date.now());
    expect(purged).toEqual(["not-a-stamp"]);
  });

  test("an empty or missing temp root is not an error", async () => {
    expect(await purgeStaleTempTakes({ STC_TEMP_TAKES_DIR: join(tempRoot, "nope") })).toEqual([]);
  });

  test("a stray file (not a directory) at the root is ignored", async () => {
    writeFileSync(join(tempRoot, ".DS_Store"), "");
    await expect(purgeStaleTempTakes(env)).resolves.toEqual([]);
  });
});

describe("listTempTakes — crash recovery's input", () => {
  let tempRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "stc-list-"));
    env = { STC_TEMP_TAKES_DIR: tempRoot };
  });
  afterEach(() => { rmSync(tempRoot, { recursive: true, force: true }); });

  function put(name: string, files: string[]) {
    const dir = join(tempRoot, name);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), "");
  }

  test("classifies by which document is inside — shot.json is a still, anchors.json a recording", async () => {
    put("2026-09-16_09-00-00", ["shot.json", "frame.png"]);
    put("2026-09-16_10-00-00", ["anchors.json", "events.json", "display.mp4"]);
    put("2026-09-16_11-00-00", []);
    const items = await listTempTakes(env);
    const kinds = Object.fromEntries(items.map((i) => [i.name, i.kind]));
    expect(kinds["2026-09-16_09-00-00"]).toBe("still");
    expect(kinds["2026-09-16_10-00-00"]).toBe("recording");
    expect(kinds["2026-09-16_11-00-00"]).toBe("unknown");
  });

  test("most recent first, matching the library grid's own sort", async () => {
    put("2026-09-16_09-00-00", ["shot.json"]);
    put("2026-09-16_11-00-00", ["shot.json"]);
    put("2026-09-16_10-00-00", ["shot.json"]);
    const items = await listTempTakes(env);
    expect(items.map((i) => i.name)).toEqual([
      "2026-09-16_11-00-00", "2026-09-16_10-00-00", "2026-09-16_09-00-00",
    ]);
  });

  test("an empty or missing temp root lists nothing", async () => {
    expect(await listTempTakes({ STC_TEMP_TAKES_DIR: join(tempRoot, "nope") })).toEqual([]);
    expect(await listTempTakes(env)).toEqual([]);
  });
});
