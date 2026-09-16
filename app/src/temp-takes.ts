import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readdir, stat, mkdir, rename, cp, rm } from "node:fs/promises";
import { join, resolve, sep, basename } from "node:path";
import { takesRoot, stamp, uniqueTakeName } from "./takes.js";

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
  return env.STC_TEMP_TAKES_DIR
    || join(homedir(), "Library", "Application Support", "stc-screen-recorder", "temp-takes");
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
 * The decision point: move a take out of temp storage and into the library.
 *
 * Idempotent in the sense that matters — a `dir` already outside the temp
 * root is returned unchanged rather than treated as an error, because every
 * call site here (`still:export`, a recording's clean stop) may run this
 * against a take that a previous call already promoted.
 *
 * Reuses the take's own directory name unless it collides with something
 * already in the library — same rule `newTakeDir` uses when two takes start
 * in the same second, applied here to the (rarer) case of two takes with the
 * same second-resolution stamp both surviving to promotion.
 */
export async function promoteTake(env: NodeJS.ProcessEnv, dir: string): Promise<string> {
  if (!insideTempTakesRoot(env, dir)) return dir;
  const root = takesRoot(env);
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
