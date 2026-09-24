import { describe, test, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ElectronApplication } from "playwright";
import { closeApp, SLOW_CLOSE_MS, APP_CLOSE_MS, CLOSE_GIVE_UP_MARGIN_MS } from "./_quit-fixture.js";
import { TRASH_COMMIT_AT_QUIT_MS } from "../src/pending-trash.js";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../src/helper-client.js";
import { QUIT_GRACE_MS } from "../src/supervisor.js";

/**
 * `closeApp` against a stub app (STC-449). A real slow close needs the macOS
 * runner, the only place one has been seen, so the stub stands in for it.
 * The stub is an app whose close prints main.ts's `[quit] teardown` line and
 * then takes a chosen time to resolve.
 */
function stubApp(closeMs: number, stderrLines: string[], failClose = false) {
  const stderr = new EventEmitter();
  const kills: string[] = [];
  const proc = Object.assign(new EventEmitter(), {
    pid: 4242, stderr, kill: (sig: string) => { kills.push(sig); return true; },
  });
  const app = {
    process: () => proc,
    close: () => new Promise<void>((resolve, reject) => {
      for (const l of stderrLines) stderr.emit("data", Buffer.from(`${l}\n`));
      // Infinity: a close that never settles, the case the give-up exists for.
      if (Number.isFinite(closeMs)) {
        setTimeout(() => (failClose ? reject(new Error("closed badly")) : resolve()), closeMs);
      }
    }),
  };
  return { app: app as unknown as ElectronApplication, stderr, kills };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("closeApp (STC-449)", () => {
  test("a slow close is reported, with the app's own [quit] stage timings", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app } = stubApp(SLOW_CLOSE_MS + 100, [
      "some unrelated line",
      "[quit] teardown trash=0ms thumbnail=2ms overlay=3ms helper=9000ms",
    ]);
    await closeApp(app);
    const out = write.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("[closeApp] app.close() took");
    expect(out).toContain("pid 4242");
    expect(out).toContain("helper=9000ms");
    expect(out).not.toContain("some unrelated line");
  }, SLOW_CLOSE_MS + 5_000);

  test("a slow close with no [quit] line says so, rather than printing nothing about it", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app } = stubApp(SLOW_CLOSE_MS + 100, []);
    await closeApp(app);
    expect(write.mock.calls.map((c) => String(c[0])).join("")).toContain("no [quit] line was printed");
  }, SLOW_CLOSE_MS + 5_000);

  test("a fast close prints nothing, and its listener is removed", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { app, stderr } = stubApp(10, ["[quit] teardown trash=0ms"]);
    await closeApp(app);
    expect(write).not.toHaveBeenCalled();
    expect(stderr.listenerCount("data")).toBe(0);
  });

  test("a close that rejects is swallowed, as the old afterEach's .catch did", async () => {
    const { app } = stubApp(10, [], true);
    await expect(closeApp(app)).resolves.toBeUndefined();
  });

  test("a close that never finishes is killed before the hook bound, and fails naming what it saw", async () => {
    const { app, kills, stderr } = stubApp(Infinity, ["[quit] teardown trash=5001ms"]);
    const hookBound = CLOSE_GIVE_UP_MARGIN_MS + 200;   // gives up at 200 ms
    const t0 = Date.now();
    await expect(closeApp(app, hookBound)).rejects.toThrow(/did not finish within 200ms.*pid 4242 was killed.*trash=5001ms/);
    expect(Date.now() - t0).toBeLessThan(hookBound);
    expect(kills).toEqual(["SIGKILL"]);
    expect(stderr.listenerCount("data")).toBe(0);
  });

  test("no app is a no-op", async () => {
    await expect(closeApp(undefined)).resolves.toBeUndefined();
  });

  test("APP_CLOSE_MS covers every bound the quit chain runs under, not just vitest's 10 s", () => {
    const chain = TRASH_COMMIT_AT_QUIT_MS + 2 * DEFAULT_REQUEST_TIMEOUT_MS + QUIT_GRACE_MS;
    // Where closeApp gives up, not the hook bound itself: the chain has to
    // fit inside the time closeApp actually waits.
    expect(APP_CLOSE_MS - CLOSE_GIVE_UP_MARGIN_MS).toBeGreaterThan(chain);
    expect(APP_CLOSE_MS).toBeGreaterThan(10_000);
  });
});
