/**
 * A recording's Copy, decided without Electron (STC-488).
 *
 * Copy on a recording RENDERS: a fresh take's only video is display.mp4, which
 * has no cursor and no zoom (the pointer exists only in a render). The render
 * is a new file, independent of the take, so Trash after Copy can't break the
 * paste and STC-392's APFS clone has nothing to do. What carries over from
 * STC-392 is the purge: copies go after 24 h, except the one still on the
 * clipboard.
 *
 * Main does every filesystem and pasteboard call; this module only decides,
 * the same split `temp-takes.ts`'s `sweepOrphanedBundles` follows.
 *
 * STC-395: a copy is an `.mp4` (the rendered recording) or a `.gif` (the same
 * render, as an animated GIF). Both share the one name rule and the one purge.
 */
import { basename, join } from "node:path";
import { appSupportDir } from "./temp-takes.js";
import { PRODUCT_NAME } from "./product.js";
import { uniqueTakeName } from "./takes.js";

export const PARTIAL_SUFFIX = ".partial";
/** The kinds of file a copy can be (STC-395 added GIF). Both purge alike. */
const COPY_EXTENSIONS = [".mp4", ".gif"] as const;
/** STC-392's own number. */
export const COPY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A partial this old is a crash's leftover; a render writing one finishes in seconds. */
export const PARTIAL_MAX_AGE_MS = 60 * 60 * 1000;
/** Its own timer: the temp-takes sweep runs every 12 h, which would let a 24 h copy live 36 h. */
export const COPY_PURGE_INTERVAL_MS = 60 * 60 * 1000;
/** Out of startup's way: the purge asks the helper, which may not be up yet. */
export const COPY_PURGE_FIRST_DELAY_MS = 60 * 1000;

/** Overridable for tests, exactly as `tempTakesRoot` is. Never inside a take. */
export function copiesRoot(env: NodeJS.ProcessEnv): string {
  return env.STC_COPIES_DIR || join(appSupportDir(PRODUCT_NAME), "copies");
}

/**
 * `<take leaf>.mp4`, which is what a paste shows the person. The leaf is unique
 * within the temp root (`newTempTakeDir` → `uniqueTakeName`), and a copy is
 * only ever made for a take in that root, so the name is also the cache key:
 * if this file exists, it IS this take's finished copy.
 */
export function copyPathFor(env: NodeJS.ProcessEnv, takeDir: string): string {
  return join(copiesRoot(env), `${basename(takeDir)}.mp4`);
}

/** STC-395: the GIF beside the mp4 copy; same name rule, same purge. */
export function gifCopyPathFor(env: NodeJS.ProcessEnv, takeDir: string): string {
  return join(copiesRoot(env), `${basename(takeDir)}.gif`);
}

/**
 * The saved GIF's leaf in the save folder: the take's name, or `-2`, `-3` …
 * — the collision rule take directories already use (`uniqueTakeName`). A
 * `.partial` in flight counts as taken.
 */
export function savedGifName(takeName: string, existingNames: readonly string[]): string {
  const stems = existingNames
    .filter((n) => n.endsWith(".gif") || n.endsWith(`.gif${PARTIAL_SUFFIX}`))
    .map((n) => n.slice(0, n.indexOf(".gif")));
  return `${uniqueTakeName(takeName, stems)}.gif`;
}

export interface CopyEntry { name: string; mtimeMs: number }

/**
 * Which entries of `copiesRoot` to delete. `onClipboard` is the set of
 * absolute paths on the pasteboard right now, or `undefined` when it couldn't
 * be read, in which case NOTHING is deleted: a file that might be on the
 * clipboard is worth one more hour on disk.
 */
export function purgeDecision(entries: readonly CopyEntry[], now: number,
                              onClipboard: ReadonlySet<string> | undefined,
                              root: string): string[] {
  if (!onClipboard) return [];
  const out: string[] = [];
  for (const e of entries) {
    const age = now - e.mtimeMs;
    const ext = COPY_EXTENSIONS.find((x) => e.name.endsWith(x) || e.name.endsWith(`${x}${PARTIAL_SUFFIX}`));
    if (!ext) continue;
    if (e.name.endsWith(PARTIAL_SUFFIX)) {
      if (age > PARTIAL_MAX_AGE_MS) out.push(e.name);
      continue;
    }
    if (onClipboard.has(join(root, e.name))) continue;
    if (age > COPY_MAX_AGE_MS) out.push(e.name);
  }
  return out;
}
