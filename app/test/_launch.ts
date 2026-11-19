/**
 * The ONE way an e2e test launches the app (STC-658).
 *
 * STC-403 found tests that ran the app on the developer's real
 * `~/Library/Application Support/Capture`, and fixed it one launcher at a time
 * with a guard that checked one flag. The 2026-11-13 review found the same
 * defect where the guard did not look: 44 launchers left the copies folder on
 * its real default (and `purgeCopies` deletes from it 60 s after launch), every
 * Delete moved a folder into the real Trash, and copies landed on the real
 * clipboard. Each launcher had its own list of roots, and each list was short
 * by a different one.
 *
 * So the list lives here, once. `launchIsolated` takes `electron.launch`'s own
 * options and adds, for every root the app writes outside a take folder:
 *
 * | root            | how                     | default                  |
 * |-----------------|-------------------------|--------------------------|
 * | user data       | `--user-data-dir=`      | a fresh temp folder      |
 * | recordings      | `STC_RECORDINGS_DIR`    | a fresh temp folder      |
 * | temp takes      | `STC_TEMP_TAKES_DIR`    | a fresh temp folder      |
 * | copies          | `STC_COPIES_DIR`        | a fresh temp folder      |
 * | Trash           | `STC_TRASH_DIR`         | a fresh temp folder      |
 * | clipboard       | `STC_PASTEBOARD`        | a private pasteboard name |
 *
 * plus `STC_NO_SHUTTER=1`, so a capture makes no sound on the machine.
 *
 * A test may pass its own value for any root (a prepared library, a log it
 * reads back), and that value must be a folder under the system temp
 * directory: anything else throws before the app starts. `rootsOf(app)` gives
 * a test the roots its app was launched with, the Trash folder included.
 *
 * `e2e-user-data-isolation.test.ts` refuses `electron.launch(` anywhere in
 * `app/test/` except this file, and checks this file sets every root above.
 */
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtempSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname } from "node:path";

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;

/** Every env var that names a folder the app writes to. Order is the table's. */
export const ROOT_ENV = ["STC_RECORDINGS_DIR", "STC_TEMP_TAKES_DIR", "STC_COPIES_DIR", "STC_TRASH_DIR"] as const;
export type RootEnv = (typeof ROOT_ENV)[number];

export type Roots = {
  userData: string;
  pasteboard: string;
} & Record<RootEnv, string>;

const USER_DATA_FLAG = "--user-data-dir=";
const launched = new WeakMap<ElectronApplication, Roots>();
let pasteboards = 0;

function realTmp(): string {
  return realpathSync(tmpdir());
}

/**
 * Is `p` a folder under the system temp directory? Resolved through symlinks
 * (macOS's `/var` is `/private/var`) and, for a folder not made yet, through
 * its nearest existing parent.
 */
export function isUnderTmp(p: string, tmp: string = realTmp()): boolean {
  if (!p) return false;
  let at = resolve(p);
  const tail: string[] = [];
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return false;
    tail.unshift(at.slice(up.length + (up.endsWith(sep) ? 0 : 1)));
    at = up;
  }
  const real = join(realpathSync(at), ...tail);
  return real !== tmp && real.startsWith(tmp + sep);
}

function refuse(what: string, value: string): never {
  throw new Error(`launchIsolated: ${what} must be a folder under ${realTmp()}, got ${JSON.stringify(value)} (STC-658)`);
}

/** `electron.launch`, with every root the app writes to pointed at a temp folder. */
export async function launchIsolated(opts: LaunchOptions = {}): Promise<ElectronApplication> {
  const args = [...(opts.args ?? [])];
  const given = args.find((a) => a.startsWith(USER_DATA_FLAG));
  let userData: string;
  if (given) {
    userData = given.slice(USER_DATA_FLAG.length);
    if (!isUnderTmp(userData)) refuse("--user-data-dir", userData);
  } else {
    userData = mkdtempSync(join(tmpdir(), "stc-ud-"));
    args.push(USER_DATA_FLAG + userData);
  }

  const caller = (opts.env ?? {}) as Record<string, string | undefined>;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const roots = { userData } as Roots;
  for (const name of ROOT_ENV) {
    const v = caller[name];
    if (v !== undefined && !isUnderTmp(v)) refuse(name, v);
    roots[name] = v ?? mkdtempSync(join(tmpdir(), `stc-${name.slice(4).toLowerCase().replace(/_/g, "-")}-`));
  }
  roots.pasteboard = caller.STC_PASTEBOARD || `stc-e2e-${process.pid}-${++pasteboards}`;
  for (const [k, v] of Object.entries(caller)) if (v !== undefined) env[k] = v;
  for (const name of ROOT_ENV) env[name] = roots[name];
  env.STC_PASTEBOARD = roots.pasteboard;
  env.STC_NO_SHUTTER = caller.STC_NO_SHUTTER ?? "1";

  const app = await electron.launch({ ...opts, args, env });
  launched.set(app, roots);
  return app;
}

/** The roots `app` was launched with. Throws for an app that did not come from `launchIsolated`. */
export function rootsOf(app: ElectronApplication): Roots {
  const r = launched.get(app);
  if (!r) throw new Error("rootsOf: this app was not launched through launchIsolated");
  return r;
}
