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
 * Same lesson as STC-413's `.orphaned-at` marker (gone since STC-435): a
 * marker whose content cannot be read as a positive number (the zero-byte
 * shape a crash mid-`writeFile` leaves) must not read as ancient — here it reads as NOT OFFERED, which is
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
 * right call; see `findOrphanedBundles` for the contrasting `raw/` case).
 *
 * **A take that has never been offered is never purged, however old.** This
 * used to measure age from the take's own timestamped name, on the premise
 * that "nothing legitimate stays in temp for anywhere near 7 days". Two things
 * legitimately do, and both are ones this app itself PROMISES to offer back on
 * the next launch: a recording whose panel was ignored, bumped, or never
 * shown (STC-487 — a stop no longer promotes), and a still whose panel was
 * ignored, bumped by a Record, or left behind by Quit Anyway (STC-392). A menu-bar app
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
 * What kind of take a `raw/` bundle holds, read from its document the way
 * `library.ts`'s own scan does: `shot.json` is a still, `anchors.json` a
 * recording. `unknown` is a bundle with neither — a take that died before
 * its document was written — and is treated as possibly EITHER kind below.
 */
export type BundleKind = "recording" | "still" | "unknown";

/** A `raw/` bundle no top-level file points back at — safe to offer for the Trash. */
export interface OrphanedBundle {
  dir: string;
  /** The bundle directory's own name (its capture timestamp). */
  name: string;
  kind: BundleKind;
  /** Everything under the bundle, recursively — what moving it to the Trash frees. */
  bytes: number;
}

/** A bundle that may be orphaned but cannot be PROVEN so, and the files in the way. */
export interface BlockedBundle extends OrphanedBundle {
  /** Top-level file names (with extension) whose capture id could not be read. */
  blockers: string[];
}

export interface ReclaimReport {
  orphans: OrphanedBundle[];
  blocked: BlockedBundle[];
}

/** Recursive size, never following a symlink — the same `lstat` rule as the walk itself. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = await lstat(p);
      total += st.isDirectory() ? await treeBytes(p) : st.size;
    } catch { /* vanished mid-scan */ }
  }
  return total;
}

/**
 * Find `raw/` bundles whose finished file is gone (STC-413), for "Reclaim
 * space" (STC-435) to show the user before anything moves. **Read-only:
 * this never writes, moves or removes anything** — not even a marker.
 *
 * ## Why there is no clock any more
 *
 * This used to run unattended on a 12-hour timer, and so needed a 7-day
 * age gate measured from a `.orphaned-at` marker it wrote on first sighting
 * — the only guard between "a file is briefly out of the folder" and the
 * bundle behind it being trashed with nobody looking. STC-435 removed the
 * timer: the only caller now is a person who pressed Reclaim space and is
 * about to read the list. They are the guard, the Trash is the undo, and a
 * marker written on a READ would have been a write the user never asked for.
 * Any `.orphaned-at` left from before is a dotfile inside a bundle and goes
 * with it.
 *
 * ## Orphanhood is proven per KIND, not per folder
 *
 * "No top-level file carries this bundle's id" is only proof when every file
 * that COULD be its export had a readable id: a JPEG export carries none
 * (STC-440), and a foreign file (a ⇧⌘4 screenshot) none either. The STC-413
 * version gated the whole pass on that — one untagged file anywhere and
 * nothing was reported, indefinitely, with a stderr line nobody saw. But
 * rule 1 of `library.ts`'s scan reads the extension as the kind (`.mp4` is a
 * recording, an image is a still), so an untagged image can only be hiding a
 * STILL's export, and an untagged `.mp4` only a RECORDING's. A bundle is
 * offered when no untagged file of its own kind exists; otherwise it is
 * reported as `blocked`, naming the files in the way, and never offered.
 * A bundle of `unknown` kind is blocked by an untagged file of either kind.
 * That is still the right way to be wrong — keeping a bundle that might be
 * someone's source material beats trashing one that was — just no longer
 * wrong about the kinds that cannot be.
 *
 * A bundle with no readable `capture.json` (never exported, or one that will
 * not parse) has nothing to match against a finished file at all and is in
 * neither list — it is either mid-flight or something `library.ts`'s own
 * scan already reports as broken.
 *
 * Electron-free on purpose: this only DECIDES. `main.ts` asks the user, then
 * trashes through `shell.trashItem` — never `rm`, because `raw/` sits inside
 * the user's own visible folder, so a mistaken click must be one Finder
 * restore away (contrast `purgeStaleTempTakes`, whose root is invisible and
 * already abandoned).
 */
export async function findOrphanedBundles(env: NodeJS.ProcessEnv,
                                          saveFolder: string | null): Promise<ReclaimReport> {
  const report: ReclaimReport = { orphans: [], blocked: [] };
  const root = rawRoot(env, saveFolder);
  let names: string[];
  try { names = await readdir(root); } catch { return report; }

  // Rule 1's own scan, reused — a second id-matching pass here would be the
  // two-owners defect this codebase keeps paying for.
  const finished = await scanFinishedFilesAt(env, saveFolder);
  const idsPresent = new Set(
    finished.map((f) => f.id).filter((id): id is string => id !== undefined));
  // The extension as the kind: `.mp4` is a recording, any other media
  // extension a still — the same reading `library.ts` makes for `isVideo`.
  const untagged = finished.filter((f) => f.id === undefined);
  const untaggedOf = (kind: BundleKind): string[] => untagged
    .filter((f) => kind === "unknown" || (f.ext === ".mp4") === (kind === "recording"))
    .map((f) => basename(f.file));

  for (const name of [...names].sort().reverse()) {      // newest first, like the library
    if (name.startsWith(".")) continue;                  // never a bundle
    const dir = join(root, name);
    let st;
    // lstat, never stat: `stat` follows a symlink, so a symlinked entry
    // under `raw/` would be offered for the Trash as if it were a bundle,
    // and sized by reading wherever the link points — outside this
    // function's declared root. `resolve()`-based path checks would NOT
    // catch this either, since `resolve()` does not follow symlinks.
    try { st = await lstat(dir); } catch { continue; }    // vanished mid-scan
    if (!st.isDirectory()) continue;                      // not a real directory (a symlink included)

    // Through `readBundleId`, the one reader (M2).
    const bundleId = await readBundleId(dir);
    if (bundleId === undefined) continue;
    if (idsPresent.has(bundleId)) continue;              // its file is here

    const kind: BundleKind = existsSync(join(dir, "shot.json")) ? "still"
                           : existsSync(join(dir, "anchors.json")) ? "recording" : "unknown";
    const entry = { dir, name, kind, bytes: await treeBytes(dir) };
    const blockers = untaggedOf(kind);
    if (blockers.length > 0) report.blocked.push({ ...entry, blockers });
    else report.orphans.push(entry);
  }
  return report;
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
    // The record-time seed (STC-493) is written the moment a take starts, so a
    // take the helper never got a byte into holds only this. It is a preference,
    // not a recording — counting it would offer an empty take for recovery.
    if (n === "project.json") continue;
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
