import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readdir, stat, lstat, mkdir, rename, cp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { rawRoot, stamp, uniqueTakeName } from "./takes.js";
import { scanFinishedFilesAt } from "./library.js";
import { readBundleId } from "./capture-identity.js";
import { PRODUCT_NAME, LEGACY_APP_DIR_NAME } from "./product.js";

/**
 * Where a capture lives before it is saved (STC-393).
 *
 * `recorder:start` and `still:capture` used to write straight into the
 * library (`takesRoot`), so every capture was permanent from its first byte.
 * STC-392's panel model needs somewhere for a take to sit between capture and
 * a decision — Save, Copy, Trash — and until that decision, a crash or a
 * force-quit must not leave a half-written file sitting in the library next
 * to things the user actually kept.
 *
 * ## Why Application Support, not Caches
 *
 * The ticket's own "Open" section names both and picks Application Support:
 * `~/Library/Caches` is purgeable by the OS on its own schedule (memory
 * pressure, disk pressure, an update), which is exactly wrong for a
 * recording that might be forty minutes long and mid-flight — the OS must
 * not be able to sweep it out from under the helper mid-write. This module
 * owns the purge instead, on a schedule this app controls (7 days, checked at
 * launch and periodically).
 *
 * ## Two roots, one naming rule
 *
 * A temp take and a library take are named the same way — a sortable
 * timestamp, `takes.ts`'s `stamp` — so `promoteTake` can usually keep a
 * take's own name across the move; only a genuine same-second collision in
 * the DESTINATION gets a suffix, via the exact rule `newTakeDir` already
 * uses (`uniqueTakeName`), not a second copy of it.
 */

/**
 * Electron-free on purpose, matching `takes.ts`: no `app.getPath`, so this is
 * testable without a running app and without a Mac. Overridable the same way
 * `STC_RECORDINGS_DIR` is, for the same reason — tests must not litter a real
 * user's Application Support folder.
 */
export function tempTakesRoot(env: NodeJS.ProcessEnv): string {
  return env.STC_TEMP_TAKES_DIR || join(appSupportDir(PRODUCT_NAME), "temp-takes");
}

/** `~/Library/Application Support/<name>` — the one place that shape is spelled. */
function appSupportDir(name: string): string {
  return join(homedir(), "Library", "Application Support", name);
}

/**
 * Where temp takes lived before the app was renamed to Capture (STC-397).
 *
 * This root is derived from `PRODUCT_NAME` rather than from
 * `app.getPath("userData")` — this module is deliberately Electron-free —
 * so the rename moves it exactly as it moves `userData`, and unsaved takes
 * from before the rename would be left in a folder nothing looks at any
 * more. They are not lost, just invisible: the crash-recovery prompt
 * (main.ts) reads the CURRENT root, so without this it would report
 * "0 unsaved takes" over a folder that still had them.
 */
export function legacyTempTakesRoot(): string {
  return join(appSupportDir(LEGACY_APP_DIR_NAME), "temp-takes");
}

/**
 * Carry unsaved takes across the rename, once.
 *
 * Deliberately a no-op when `STC_TEMP_TAKES_DIR` is set: that override is
 * how every test isolates itself, and a test's fresh temp root must never
 * be handed the real user's leftovers. Also a no-op once the new root
 * exists — this runs on every launch, and a second run must not undo what
 * a capture has done since the first.
 *
 * Failures are reported by the caller and never fatal: the worst case is
 * that some unsaved takes stay where they are, which is the situation this
 * function exists to improve rather than a new way to lose them.
 */
export async function migrateLegacyTempTakes(env: NodeJS.ProcessEnv): Promise<number> {
  if (env.STC_TEMP_TAKES_DIR) return 0;
  const from = legacyTempTakesRoot();
  const to = tempTakesRoot(env);
  if (from === to || !existsSync(from) || existsSync(to)) return 0;
  await mkdir(join(to, ".."), { recursive: true });
  await moveDir(from, to);
  try { return (await readdir(to)).length; } catch { return 0; }
}

/** `insideTakesRoot`'s traversal/sibling closure, against the temp root instead. */
export function insideTempTakesRoot(env: NodeJS.ProcessEnv, dir: string): boolean {
  if (typeof dir !== "string" || dir.length === 0) return false;
  const root = resolve(tempTakesRoot(env));
  const target = resolve(dir);
  return target !== root && (target + sep).startsWith(root + sep);
}

/** A fresh temp take directory, named exactly like a library one would be. */
export function newTempTakeDir(env: NodeJS.ProcessEnv, at: Date = new Date(),
                               existing: string[] = []): string {
  return join(tempTakesRoot(env), uniqueTakeName(stamp(at), existing));
}

/**
 * Move `from` to `to`, tolerating the two roots living on different volumes.
 *
 * `rename` is atomic and near-instant when it works, which is the common
 * case (Application Support and Desktop are normally the same volume). EXDEV
 * is the one error worth a fallback for — anything else (permissions, a
 * vanished source) is a real failure and should propagate as one.
 */
async function moveDir(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err: any) {
    if (err?.code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * The decision point: move a take out of temp storage and into its source
 * bundle's home, `raw/` (STC-413) — the library's finished-capture root is a
 * view of exported files, and a promoted take has not been exported yet.
 *
 * Idempotent in the sense that matters — a `dir` already outside the temp
 * root is returned unchanged rather than treated as an error, because every
 * call site here (`still:export`, a recording's clean stop) may run this
 * against a take that a previous call already promoted.
 *
 * Reuses the take's own directory name unless it collides with something
 * already in `raw/` — same rule `newTakeDir` uses when two takes start in the
 * same second, applied here to the (rarer) case of two takes with the same
 * second-resolution stamp both surviving to promotion.
 */
export async function promoteTake(env: NodeJS.ProcessEnv, saveFolder: string | null,
                                  dir: string): Promise<string> {
  if (!insideTempTakesRoot(env, dir)) return dir;
  const root = rawRoot(env, saveFolder);
  await mkdir(root, { recursive: true });
  const existing = existsSync(root) ? await readdir(root) : [];
  const dest = join(root, uniqueTakeName(basename(dir), existing));
  await moveDir(dir, dest);
  return dest;
}

/** How long an unsaved take is allowed to sit in temp storage before it is purged. */
export const TEMP_TAKE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A temp directory's age, from its OWN name where possible.
 *
 * The name is a timestamp (`takes.ts`'s `stamp`) written at the moment the
 * take was created, which is the age that matters — a shot someone reopened
 * to look at (bumping mtime) is not "fresher" for purge purposes just because
 * something touched it. `mtime` is the fallback for a directory this module
 * did not name — defensive, not expected, since nothing else writes here.
 */
function parseStamp(name: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = m.slice(1, 7);
  const dt = new Date(Number(year), Number(month) - 1, Number(day),
                      Number(hour), Number(minute), Number(second));
  return Number.isNaN(dt.getTime()) ? undefined : dt;
}

async function ageMs(dir: string, name: string, now: number): Promise<number> {
  const parsed = parseStamp(name);
  if (parsed) return now - parsed.getTime();
  try { return now - (await stat(dir)).mtimeMs; } catch { return 0; }
}

/**
 * Delete every temp take older than {@link TEMP_TAKE_MAX_AGE_MS}, permanently
 * (not to the Trash — this is an already-abandoned take the user never
 * interacted with, not a deliberate discard someone might want back).
 *
 * Called once at launch, before anything checks what is left for crash
 * recovery, and on a timer while the app runs. Never removes anything a live
 * panel or an in-progress recording could still be using: nothing legitimate
 * stays in temp for anywhere near 7 days, so age alone is a safe filter with
 * no separate "is this claimed" bookkeeping.
 */
export async function purgeStaleTempTakes(env: NodeJS.ProcessEnv,
                                          now: number = Date.now()): Promise<string[]> {
  const root = tempTakesRoot(env);
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }

  const purged: string[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
    } catch { continue; }
    if (await ageMs(dir, name, now) >= TEMP_TAKE_MAX_AGE_MS) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      purged.push(name);
    }
  }
  return purged;
}

/**
 * The dotfile marking a bundle first seen orphaned (STC-413).
 *
 * Its contents are the epoch ms it was written, so age is measured from the
 * SIGHTING rather than from the bundle's own (possibly much older) creation
 * date. Named with a leading dot as defensive convention, matching what
 * `library.ts`'s scan already does one level up for `raw/`'s own children —
 * but that convention does NOT hide this file from anything by itself: the
 * scan's dotfile skip (rule 2) only applies to `raw/`'s direct children
 * (sibling bundle directories); this marker sits one level deeper, inside a
 * bundle, where nothing else ever looks at it.
 */
export const ORPHAN_MARKER_FILE = ".orphaned-at";

/**
 * Find `raw/` bundles whose finished file is gone (STC-413), and return
 * their directories. **Never deletes anything here.**
 *
 * This module is deliberately Electron-free, and the object being reported
 * is a `raw/` bundle — the SAME kind of object Task 11 already removes, via
 * `shell.trashItem`, under the rule "never `rm`, so a mistaken click is one
 * Finder restore away." `rawRoot` sits inside the user's own chosen folder,
 * visible and reachable — unlike `purgeStaleTempTakes`'s root, which lives
 * inside `~/Library/Application Support`, invisible and already abandoned,
 * where a bare `rm` is the right call. So this function only DECIDES; the
 * caller (`main.ts`, the same 12-hour timer that already runs
 * `purgeStaleTempTakes`) is what actually trashes each returned directory —
 * the identical `pendingTrash.due()` -> `shell.trashItem` split one call
 * site over.
 *
 * A bundle is reported as due only when it is BOTH orphaned and aged — two
 * independent conditions, and dropping either is the exact bug this function
 * exists not to have (see the mutation check in `orphan-sweep.test.ts`):
 *
 *  - AGE ALONE is wrong. `purgeStaleTempTakes` derives age from the
 *    directory's own NAME, which is right for a transient temp take and
 *    wrong here — a bundle behind a capture made eight days ago would be
 *    reported while its finished file still sits at top level, silently
 *    making it uneditable. So age here is measured from a MARKER written
 *    the first time the bundle was seen orphaned, never from its creation
 *    date. **The marker's own content must not be misreadable as ancient**:
 *    `Number("")` is `0`, which is finite, so a zero-byte or
 *    whitespace-only marker (exactly the shape a crash leaves mid
 *    `writeFile` — it truncates before it writes, and the likeliest cause
 *    of a truncated write is a full disk, the very condition this sweep
 *    exists to relieve) must read as a FRESH sighting, never as epoch 0.
 *  - ORPHAN STATUS ALONE is wrong too: a read must not delete data, and a
 *    file temporarily moved out of the folder would read as deleted on one
 *    pass and reappear the next. So a first sighting only marks; being
 *    reported as due needs the mark to already be old, and a file coming
 *    back clears it.
 *
 * "No matched file" is not, by itself, "orphaned" — see this module's own
 * task brief. After Task 8's scan, a bundle with no matched file is one of
 * three different things: its file was really deleted; its file is a
 * JPEG/HEIC, whose id is deliberately never read (`library.ts`); or its file
 * was moved out of the folder. Only the first is a real orphan, and nothing
 * here can tell the three apart *for one bundle* — but if EVERY top-level
 * file yielded a readable id, then any bundle with no match among them truly
 * has none. So orphanhood is proven for the whole pass at once, by reusing
 * `scanFinishedFilesAt` (Task 8's own file scan — a second id-matching pass
 * here would be the two-owners defect this codebase keeps paying for): if
 * any top-level file's id could not be read, no bundle's orphan status can
 * be proven this pass, and NOTHING is reported. The cost is accepted and
 * stated rather than hidden: a folder containing even one untagged file
 * never reclaims disk from `raw/` until that file is read, moved out, or
 * deleted. That is the right way to be wrong — keeping a bundle that might
 * still be someone's source material beats deleting one that was.
 *
 * A bundle with no readable `capture.json` (never exported, or one that
 * cannot be parsed) has nothing to match against a finished file at all and
 * is not this sweep's concern — it is either mid-flight or something
 * `library.ts`'s own scan already reports as broken.
 */
export async function sweepOrphanedBundles(env: NodeJS.ProcessEnv, saveFolder: string | null,
                                           now: number = Date.now()): Promise<string[]> {
  const root = rawRoot(env, saveFolder);
  let names: string[];
  try { names = await readdir(root); } catch { return []; }

  const finished = await scanFinishedFilesAt(env, saveFolder);
  const provable = finished.every((f) => f.id !== undefined);
  if (!provable) {
    console.error(
      "[orphan-sweep] skipped — a top-level file with no readable id is present, " +
      "so no bundle's orphan status can be proven this pass");
    return [];
  }
  const idsPresent = new Set(
    finished.map((f) => f.id).filter((id): id is string => id !== undefined));

  const due: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;                  // never a bundle
    const dir = join(root, name);
    let st;
    // lstat, never stat: `stat` follows a symlink, so a symlinked entry
    // under `raw/` would have this function read/write through it into
    // wherever the link points — outside this function's declared root.
    // `insideTakesRoot`-style path checks would NOT catch this either,
    // since `resolve()` does not follow symlinks.
    try { st = await lstat(dir); } catch { continue; }    // vanished mid-scan
    if (!st.isDirectory()) continue;                      // not a real directory (a symlink included)

    // Never exported, or an unreadable capture.json: not orphaned, just
    // unfinished. Through `readBundleId`, the one reader (M2) — this was its
    // own inline copy, and the three copies did not agree.
    const bundleId = await readBundleId(dir);
    if (bundleId === undefined) continue;

    const markerPath = join(dir, ORPHAN_MARKER_FILE);
    if (idsPresent.has(bundleId)) {
      // The file is here — or came back. Clear any stale mark so a
      // temporary move costs nothing. This is our own bookkeeping dotfile,
      // never the bundle itself, so a plain `rm` is the right tool here.
      await rm(markerPath, { force: true }).catch(() => {});
      continue;
    }

    // A marker that cannot be read as a positive number is a FRESH sighting,
    // never an ancient one — see the header's note on why `Number("")` (0)
    // must not be trusted.
    let markedAt: number | undefined;
    try {
      const text = (await readFile(markerPath, "utf8")).trim();
      const n = Number(text);
      markedAt = text !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
    } catch { /* not yet marked — this is the first sighting */ }

    if (markedAt === undefined) {
      await writeFile(markerPath, String(now));
      continue;
    }
    if (now - markedAt >= TEMP_TAKE_MAX_AGE_MS) {
      due.push(dir);
    }
  }
  return due;
}

export interface TempTakeInfo {
  dir: string;
  name: string;
  /** `shot.json` present → still; `anchors.json` present → recording; neither → unrecognised. */
  kind: "still" | "recording" | "unknown";
}

/**
 * Every take currently sitting in temp storage, most recent first (matching
 * the library's own sort — `library.ts`'s `scanRoot`).
 *
 * Called once at launch, after the purge, to find what a previous run left
 * behind with no panel to claim it — crash recovery's whole input. Nothing
 * can be "claimed" yet at that point in startup, since no capture has run
 * this session, so every entry here is by definition orphaned.
 */
export async function listTempTakes(env: NodeJS.ProcessEnv): Promise<TempTakeInfo[]> {
  const root = tempTakesRoot(env);
  let entries: string[];
  try { entries = await readdir(root); } catch { return []; }

  const out: TempTakeInfo[] = [];
  for (const name of entries.sort().reverse()) {
    const dir = join(root, name);
    let names: string[];
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      names = await readdir(dir);
    } catch { continue; }
    const kind = names.includes("shot.json") ? "still"
               : names.includes("anchors.json") ? "recording" : "unknown";
    out.push({ dir, name, kind });
  }
  return out;
}
