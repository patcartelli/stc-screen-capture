import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import {
  mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  tempTakesRoot, insideTempTakesRoot, newTempTakeDir, promoteTake,
  purgeStaleTempTakes, listTempTakes, TEMP_TAKE_MAX_AGE_MS,
  markOfferedForRecovery, RECOVERY_OFFERED_FILE,
  legacyTempTakesRoot, migrateLegacyTempTakes,
} from "../src/temp-takes.js";
import { PRODUCT_NAME, LEGACY_APP_DIR_NAME } from "../src/product.js";
import { RAW_SUBDIR } from "../src/takes.js";

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

  test("moves the whole directory into raw/, keeping its own name (STC-413)", async () => {
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, null, dir);
    expect(dest).toBe(join(libRoot, RAW_SUBDIR, "2026-09-16_10-00-00"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dest, "shot.json"))).toBe(true);
  });

  test("creates raw/ if this is the first promotion ever", async () => {
    rmSync(libRoot, { recursive: true, force: true });
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, null, dir);
    expect(existsSync(dest)).toBe(true);
  });

  test("a name collision in raw/ gets the same -2 suffix newTakeDir would give it", async () => {
    mkdirSync(join(libRoot, RAW_SUBDIR, "2026-09-16_10-00-00"), { recursive: true });
    const dir = makeTempTake("2026-09-16_10-00-00");
    const dest = await promoteTake(env, null, dir);
    expect(dest).toBe(join(libRoot, RAW_SUBDIR, "2026-09-16_10-00-00-2"));
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
    expect(dest).toBe(join(chosen, RAW_SUBDIR, "2026-09-16_10-00-00"));
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(dest, "shot.json"))).toBe(true);
    // ...and NOT the env-derived library root.
    expect(existsSync(join(libRoot, RAW_SUBDIR, "2026-09-16_10-00-00"))).toBe(false);
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

  function take(name: string, files: Record<string, string> = { "shot.json": "{}" }): string {
    const dir = join(tempRoot, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
    return dir;
  }

  // ── The STC-465 review finding: nothing is purged before it is offered ──
  //
  // A recording whose promotion failed, or a still whose panel was ignored,
  // legitimately sits in temp storage waiting for the next launch's recovery
  // prompt — main.ts promises the user exactly that. Measuring age from the
  // take's own NAME deleted such a take on the first relaunch (or 12-hour
  // sweep) after day 7, before the prompt could ever show it. Watched failing
  // against the name-based rule: this take was purged.
  test("a take NEVER offered for recovery is never purged, however old", async () => {
    const stranded = take("2020-01-01_00-00-00", { "anchors.json": "{}", "display.mp4": "x" });
    const now = new Date("2026-09-16T00:00:00").getTime();
    expect(await purgeStaleTempTakes(env, now)).toEqual([]);
    expect(existsSync(stranded)).toBe(true);
    // Not even a directory this module did not name, aged by mtime — the old
    // fallback — since age from creation is no longer the question at all.
    const weird = take("not-a-stamp");
    const old = Date.now() - TEMP_TAKE_MAX_AGE_MS * 10;
    utimesSync(weird, old / 1000, old / 1000);
    expect(await purgeStaleTempTakes(env, Date.now())).toEqual([]);
    expect(existsSync(weird)).toBe(true);
  });

  test("a take offered 7+ days ago is purged, permanently", async () => {
    const stale = take("2020-01-01_00-00-00");
    const offered = new Date("2026-09-01T00:00:00").getTime();
    await markOfferedForRecovery(stale, offered);
    const purged = await purgeStaleTempTakes(env, offered + TEMP_TAKE_MAX_AGE_MS + 1);
    expect(purged).toEqual(["2020-01-01_00-00-00"]);
    expect(existsSync(stale)).toBe(false);
  });

  test("age runs from the OFFER, not from the capture", async () => {
    // Captured years ago, offered an hour ago: the user has had an hour.
    const dir = take("2020-01-01_00-00-00");
    const now = new Date("2026-09-16T12:00:00").getTime();
    await markOfferedForRecovery(dir, now - 60 * 60 * 1000);
    expect(await purgeStaleTempTakes(env, now)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  test("exactly at the boundary is purged; one millisecond short survives", async () => {
    const at = new Date("2026-09-01T00:00:00").getTime();
    const name = "2026-09-01_00-00-00";
    await markOfferedForRecovery(take(name), at);
    expect(await purgeStaleTempTakes(env, at + TEMP_TAKE_MAX_AGE_MS - 1)).toEqual([]);
    expect(await purgeStaleTempTakes(env, at + TEMP_TAKE_MAX_AGE_MS)).toEqual([name]);
  });

  test("the FIRST offer is the one that counts — a re-offer does not restart the clock", async () => {
    const dir = take("2026-09-01_00-00-00");
    const first = new Date("2026-09-01T00:00:00").getTime();
    await markOfferedForRecovery(dir, first);
    await markOfferedForRecovery(dir, first + 6 * 24 * 60 * 60 * 1000);
    expect(readFileSync(join(dir, RECOVERY_OFFERED_FILE), "utf8")).toBe(String(first));
    expect(await purgeStaleTempTakes(env, first + TEMP_TAKE_MAX_AGE_MS)).toEqual(["2026-09-01_00-00-00"]);
  });

  test("an unreadable marker reads as NOT offered — the direction that keeps the take", async () => {
    // `Number("")` is 0, which is finite: a zero-byte marker (a crash mid
    // `writeFile`) must not read as an offer made at the epoch.
    for (const [name, body] of [["2020-01-01_00-00-00", ""], ["2020-01-02_00-00-00", "  \n"],
                                ["2020-01-03_00-00-00", "garbage"], ["2020-01-04_00-00-00", "-5"]]) {
      take(name!, { "shot.json": "{}", [RECOVERY_OFFERED_FILE]: body! });
    }
    expect(await purgeStaleTempTakes(env, Date.now())).toEqual([]);
    // ...and a later offer repairs it rather than being refused by it.
    const dir = join(tempRoot, "2020-01-01_00-00-00");
    await markOfferedForRecovery(dir, 1234);
    expect(readFileSync(join(dir, RECOVERY_OFFERED_FILE), "utf8")).toBe("1234");
  });

  test("promotion leaves the marker behind — it is temp-storage bookkeeping, not part of the take", async () => {
    const libRoot = mkdtempSync(join(tmpdir(), "stc-purge-lib-"));
    try {
      const dir = take("2026-09-16_10-00-00");
      await markOfferedForRecovery(dir);
      const dest = await promoteTake({ ...env, STC_RECORDINGS_DIR: libRoot }, null, dir);
      expect(existsSync(join(dest, "shot.json"))).toBe(true);
      expect(existsSync(join(dest, RECOVERY_OFFERED_FILE))).toBe(false);
    } finally {
      rmSync(libRoot, { recursive: true, force: true });
    }
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
    const items = await listTempTakes(env);
    const kinds = Object.fromEntries(items.map((i) => [i.name, i.kind]));
    expect(kinds["2026-09-16_09-00-00"]).toBe("still");
    expect(kinds["2026-09-16_10-00-00"]).toBe("recording");
  });

  test("neither document, but something survived: unknown — the helper died mid-take", async () => {
    // The shape a `kill -9` or a `recording-lost` leaves: anchors.json is
    // written at STOP, so a take that never stopped has a video and no
    // document. Crash recovery must be able to tell this from `empty`.
    const dir = join(tempRoot, "2026-09-16_12-00-00");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "display.mp4"), Buffer.alloc(1024, 1));
    const [item] = await listTempTakes(env);
    expect(item!.kind).toBe("unknown");
  });

  test("nothing with a byte in it: empty — there is nothing to offer anyone", async () => {
    put("2026-09-16_11-00-00", []);                       // mkdir, then died
    put("2026-09-16_11-00-01", ["display.mp4"]);          // a zero-byte file
    put("2026-09-16_11-00-02", [".recovery-offered-at"]); // our own bookkeeping only
    const items = await listTempTakes(env);
    expect(items.map((i) => i.kind)).toEqual(["empty", "empty", "empty"]);
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
