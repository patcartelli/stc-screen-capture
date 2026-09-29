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
 * owns the purge instead, on a schedule this app controls (7 days after crash
 * recovery has offered a take back to the user, checked at launch and
 * periodically — never before that offer; see `purgeStaleTempTakes`).
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
  // Temp-storage bookkeeping, meaningless once the take has left temp
  // storage — and `raw/` is the user's own folder, so it is not left there.
  // Best-effort: a marker that survives costs a few bytes, never the take.
  await rm(join(dest, RECOVERY_OFFERED_FILE), { force: true }).catch(() => {});
  return dest;
}

/**
 * How long an unsaved take may sit in temp storage AFTER the user has been
 * offered it by crash recovery, before it is purged.
 */
export const TEMP_TAKE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The dotfile marking a temp take as already OFFERED to the user by crash
 * recovery (`main.ts`'s `recoverUnsavedTakes`) — the one fact the purge
 * needs and a take's own timestamped name cannot supply.
 *
 * Its contents are the epoch ms of the FIRST offer. It is never refreshed by
 * a later one: a take the user was shown, sent to Review and then ignored
 * again is re-offered on every launch, and a marker that moved with each
 * offer would let that take live forever — the first offer is when the user
 * was first told, and that is what the clock runs from.
 *
 * Same lesson as {@link ORPHAN_MARKER_FILE}: a marker whose content cannot be
 * read as a positive number (the zero-byte shape a crash mid-`writeFile`
 * leaves) must not read as ancient — here it reads as NOT OFFERED, which is
 * the direction that keeps the take.
 */
export const RECOVERY_OFFERED_FILE = ".recovery-offered-at";

/** The first-offer time a marker records, or undefined for "never offered". */
async function offeredAt(dir: string): Promise<number | undefined> {
  try {
    const text = (await readFile(join(dir, RECOVERY_OFFERED_FILE), "utf8")).trim();
    const n = Number(text);
    return text !== "" && Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record that crash recovery has put this temp take in front of the user
 * (a panel re-presented for it). Keeps an existing valid marker — see
 * {@link RECOVERY_OFFERED_FILE} for why the FIRST offer is the one that counts.
 */
export async function markOfferedForRecovery(dir: string, now: number = Date.now()): Promise<void> {
  if (await offeredAt(dir) !== undefined) return;
  await writeFile(join(dir, RECOVERY_OFFERED_FILE), String(now));
}

/**
 * Delete every temp take that crash recovery OFFERED to the user more than
 * {@link TEMP_TAKE_MAX_AGE_MS} ago, permanently (not to the Trash — a take the
 * user was shown and left alone for a week is abandoned, and this root lives
 * inside `~/Library/Application Support`, invisible, where a bare `rm` is the
 * right call; see `sweepOrphanedBundles` for the contrasting `raw/` case).
 *
 * **A take that has never been offered is never purged, however old.** This
 * used to measure age from the take's own timestamped name, on the premise
 * that "nothing legitimate stays in temp for anywhere near 7 days". Two things
 * legitimately do, and both are ones this app itself PROMISES to offer back on
 * the next launch: a recording whose promotion to the library failed
 * (`recording-promote-failed`, main.ts), and a still whose panel was ignored,
 * bumped by a Record, or left behind by Quit Anyway (STC-392). A menu-bar app
 * can easily run for more than a week without relaunching, and a relaunch
 * after day 7 ran this purge BEFORE the prompt that was supposed to offer the
 * take — so in both cases the take was deleted without the user ever being
 * asked (STC-465 review). Measuring from the offer instead keeps every such
 * take until the user has actually been shown it; every launch offers
 * whatever is in temp storage, so nothing unoffered outlives the next launch
 * by more than the time to answer the prompt.
 *
 * Called once at launch, before crash recovery lists what is left (an offered
 * take a week stale must not reach the prompt again), and on a timer while
 * the app runs. Never removes anything a live panel or an in-progress
 * recording could still be using: neither carries a marker that old — a
 * fresh capture has none, and a re-presented panel times out long before.
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
    const offered = await offeredAt(dir);
    if (offered !== undefined && now - offered >= TEMP_TAKE_MAX_AGE_MS) {
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
 * date.
 *
 * The leading dot is convention only — it keeps the marker out of the way in
 * Finder and says "bookkeeping, not yours". It is NOT what keeps the scan
 * from seeing it, and an earlier version of this comment leaned on the
 * scan's dotfile skip (rule 2) as if it did. That skip applies to entries
 * the scan actually enumerates: top-level files and the direct children of
 * `raw/`. This marker sits one level deeper again, INSIDE a bundle, which
 * the scan reads only through `readdir` for `dirSize` and the
 * `shot.json`/`anchors.json` checks — it was never a candidate for listing
 * whatever it was called.
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
 *  - AGE ALONE is wrong. Age from the directory's own NAME (what
 *    `purgeStaleTempTakes` used to use, before it too moved to a marker)
 *    is wrong here — a bundle behind a capture made eight days ago would be
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
 * three different things: its file was really deleted; its file is a JPEG,
 * which carries no id to read at all (`library.ts`); or its file was moved
 * out of the folder. Only the first is a real orphan, and nothing
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
  /**
   * `shot.json` present → still; `anchors.json` present → recording; neither
   * → `unknown` when anything with bytes in it survived, `empty` when nothing
   * did.
   *
   * `unknown` is not a curiosity: it is what a take looks like when the helper
   * (or the whole app) died between creating the directory and writing its
   * document — a `kill -9` mid-take, or the helper crashing mid-recording
   * (`recording-lost`), leaves a `display.mp4` and no `anchors.json`, because
   * `anchors.json` is written at STOP. So it is often the most recent,
   * most-wanted take in the list, and crash recovery must surface it rather
   * than skip it (STC-465 review).
   *
   * `empty` — a directory holding no file with a single byte in it (dotfiles
   * aside, which are only ever this module's own bookkeeping) — is the one
   * case with nothing to offer anyone: the helper made the directory and died
   * before writing anything. Classified here, in the ONE place that reads a
   * temp take's contents, so crash recovery never counts it as a take.
   */
  kind: "still" | "recording" | "unknown" | "empty";
}

/** Anything in `dir` with bytes in it, dotfiles aside — see {@link TempTakeInfo}'s `empty`. */
async function hasContent(dir: string, names: string[]): Promise<boolean> {
  for (const n of names) {
    if (n.startsWith(".")) continue;
    try {
      const st = await lstat(join(dir, n));
      // A subdirectory is not something this app ever writes into a take;
      // counted as content rather than guessed at, so it is never discarded.
      if (st.isDirectory() || st.size > 0) return true;
    } catch { /* vanished mid-scan */ }
  }
  return false;
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
               : names.includes("anchors.json") ? "recording"
               : await hasContent(dir, names) ? "unknown" : "empty";
    out.push({ dir, name, kind });
  }
  return out;
}
