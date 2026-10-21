import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeIps } from "../../scripts/ips-summary.mjs";

/**
 * `scripts/ips-summary.mjs` (STC-568) puts a crash report's faulting frames in
 * the CI job log, because the `failure-logs` artifact is unreachable from the
 * agent sessions. It only ever runs on a run that has already failed, so it
 * cannot be watched working there; this is the only place it is checked.
 *
 * The report below is synthetic but has the shape of a macOS 13+ `.ips`: a
 * one-line JSON header, then a JSON body. STC-534's crash is the model.
 */
const header = JSON.stringify({ app_name: "Electron", timestamp: "2026-10-20 11:16:01.00 +0000", bug_type: "309" });
const body = {
  procName: "Electron",
  pid: 4242,
  captureTime: "2026-10-20 11:16:01.1234 +0000",
  exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV", subtype: "KERN_INVALID_ADDRESS at 0x00000000000003de" },
  termination: { indicator: "Segmentation fault: 11" },
  asi: { "libsystem_c.dylib": ["abort() called"] },
  faultingThread: 1,
  usedImages: [{ name: "Electron Framework" }, { name: "AppKit" }],
  threads: [
    { frames: [{ imageIndex: 1, symbol: "-[NSApplication run]", symbolLocation: 4 }] },
    {
      triggered: true,
      queue: "com.apple.main-thread",
      frames: [
        { imageIndex: 0, imageOffset: 123456 },
        { imageIndex: 1, symbol: "-[NSWindow becomeKeyWindow]", symbolLocation: 88 },
        { imageIndex: 1, symbol: "-[NSApplication _handleActivatedEvent:]", symbolLocation: 12 },
      ],
    },
  ],
};
const report = `${header}\n${JSON.stringify(body, null, 2)}\n`;

describe("summarizeIps", () => {
  test("names the process, the exception and the faulting thread's frames, top first", () => {
    expect(summarizeIps(report, "Electron-2026-10-20-111601.ips")).toEqual([
      "== Electron-2026-10-20-111601.ips: Electron pid 4242 at 2026-10-20 11:16:01.1234 +0000",
      "  exception: EXC_BAD_ACCESS SIGSEGV KERN_INVALID_ADDRESS at 0x00000000000003de",
      "  termination: Segmentation fault: 11",
      "  asi: libsystem_c.dylib: abort() called",
      "  faulting thread 1 (com.apple.main-thread), top 3 of 3 frames:",
      "     0 Electron Framework +123456",
      "     1 AppKit -[NSWindow becomeKeyWindow]+88",
      "     2 AppKit -[NSApplication _handleActivatedEvent:]+12",
    ]);
  });

  test("caps the frames, and says how many there were", () => {
    const lines = summarizeIps(report, "r.ips", 1);
    expect(lines).toContain("  faulting thread 1 (com.apple.main-thread), top 1 of 3 frames:");
    expect(lines.filter((l) => /^ {4}\s?\d+ /.test(l))).toHaveLength(1);
  });

  test("finds the faulting thread by `triggered` when `faultingThread` is missing", () => {
    const { faultingThread: _, ...noIndex } = body;
    const lines = summarizeIps(`${header}\n${JSON.stringify(noIndex)}`, "r.ips");
    expect(lines).toContain("  faulting thread 1 (com.apple.main-thread), top 3 of 3 frames:");
  });

  test("prints an uncaught exception's own backtrace too", () => {
    const withLast = { ...body, lastExceptionBacktrace: [{ imageIndex: 1, symbol: "-[NSException raise]", symbolLocation: 0 }] };
    const lines = summarizeIps(`${header}\n${JSON.stringify(withLast)}`, "r.ips");
    expect(lines).toContain("  last exception backtrace, top 1 of 1:");
    expect(lines).toContain("     0 AppKit -[NSException raise]+0");
  });

  test("a report it cannot parse still prints something, and never throws", () => {
    const lines = summarizeIps("Process: Electron [4242]\nException Type: EXC_BAD_ACCESS\n", "old.crash");
    expect(lines[0]).toMatch(/^== old\.crash: not an \.ips JSON report/);
    expect(lines).toContain("  Exception Type: EXC_BAD_ACCESS");
  });

  test("a header-only report says so", () => {
    expect(summarizeIps(`${header}\n`, "h.ips")).toEqual([
      "== h.ips: Electron pid ? at 2026-10-20 11:16:01.00 +0000",
      "  (header only, no crash body)",
    ]);
  });
});

describe("the script, as CI runs it", () => {
  test("summarises every file it is given and exits 0, even for one it cannot read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ips-"));
    const file = join(dir, "Electron-1.ips");
    writeFileSync(file, report);
    const out = execFileSync(process.execPath, [join(__dirname, "..", "..", "scripts", "ips-summary.mjs"), file, join(dir, "missing.ips")], { encoding: "utf8" });
    expect(out).toContain("== Electron-1.ips: Electron pid 4242");
    expect(out).toContain("== missing.ips: could not read");
  });
});
