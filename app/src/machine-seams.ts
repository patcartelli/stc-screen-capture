/**
 * The two places the app reaches the rest of the machine with something a test
 * must not leave behind: the Trash and the text clipboard (STC-658).
 *
 * The e2e suite launches the real app dozens of times. Before this, every
 * Delete, Reclaim and quit-time commit moved a folder into the developer's
 * real `~/.Trash`, and every Pick Color or Capture Text replaced whatever was
 * on their real clipboard. `app/test/_launch.ts` sets both seams for every
 * launch:
 *
 * - `STC_TRASH_DIR`: `installTrashSeam` replaces `shell.trashItem` itself,
 *   once at boot, with a MOVE into that folder (under its own name, with a
 *   numbered suffix when the name is taken, the way the Finder's Trash does
 *   it). Replacing the method rather than every call site keeps main's four
 *   callers unchanged, and keeps the e2e tests that wrap or fail
 *   `shell.trashItem` from inside main (`library.e2e`, `library-folder.e2e`)
 *   wrapping the seam instead of escaping it to the real Trash. A test checks
 *   the folder, never `~/.Trash`.
 * - `STC_PASTEBOARD`: the name of a private pasteboard. The helper writes to
 *   `NSPasteboard(name:)` instead of the general one (`Pasteboard.swift`).
 *   Main's own text writes cannot be pointed at a named pasteboard (Electron's
 *   `clipboard` has no such argument), so under the seam they are kept in
 *   `seamPasteboardText`, which a test reads through `app.evaluate`.
 *
 * Neither seam reaches a packaged build: `seams.ts` deletes every `STC_*`
 * before main reads one (STC-657).
 *
 * Electron-free: Electron's own calls are passed in, so this is unit-tested
 * without an app (`machine-seams.test.ts`).
 */
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";

export type TrashDeps = {
  env?: NodeJS.ProcessEnv;
  /** `shell.trashItem`, the real Trash. */
  shellTrash: (path: string) => Promise<void>;
};

/** The first free `<name>`, `<name> 2`, `<name> 3`… in `dir`. */
export function freeName(dir: string, name: string, taken: (p: string) => boolean = existsSync): string {
  if (!taken(join(dir, name))) return join(dir, name);
  for (let n = 2; ; n++) {
    const p = join(dir, `${name} ${n}`);
    if (!taken(p)) return p;
  }
}

/** Move `path` to the Trash, or into `STC_TRASH_DIR` when a test set one. Returns where it went (the seam's path), or undefined for the real Trash. */
export async function trashItem(path: string, deps: TrashDeps): Promise<string | undefined> {
  const dir = (deps.env ?? process.env).STC_TRASH_DIR;
  if (!dir) {
    await deps.shellTrash(path);
    return undefined;
  }
  await mkdir(dir, { recursive: true });
  const dest = freeName(dir, basename(path));
  try {
    await rename(path, dest);
  } catch (e: any) {
    // The take and the seam's folder sit on different volumes: copy, then remove.
    if (e?.code !== "EXDEV") throw e;
    await cp(path, dest, { recursive: true, errorOnExist: true, force: false });
    await rm(path, { recursive: true, force: true });
  }
  return dest;
}

/**
 * Point `shell.trashItem` at `STC_TRASH_DIR` when a test set one. Returns
 * whether it did. Called once from main, before anything can trash.
 */
export function installTrashSeam(
  shell: { trashItem: (path: string) => Promise<void> },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!env.STC_TRASH_DIR) return false;
  const real = shell.trashItem.bind(shell);
  shell.trashItem = (path: string) => trashItem(path, { env, shellTrash: real }).then(() => undefined);
  return true;
}

/** Every text main put on the clipboard while `STC_PASTEBOARD` was set, oldest first. */
export const seamPasteboardText: string[] = [];

export type ClipboardDeps = {
  env?: NodeJS.ProcessEnv;
  /** `clipboard.writeText`, the real clipboard. */
  writeText: (text: string) => void;
};

/** Put `text` on the clipboard, or keep it in `seamPasteboardText` when a test set `STC_PASTEBOARD`. */
export function writeClipboardText(text: string, deps: ClipboardDeps): void {
  if ((deps.env ?? process.env).STC_PASTEBOARD) {
    seamPasteboardText.push(text);
    (globalThis as any).__stcSeamPasteboardText = seamPasteboardText;
    return;
  }
  deps.writeText(text);
}
