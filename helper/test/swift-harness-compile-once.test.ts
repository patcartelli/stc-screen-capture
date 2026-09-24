import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSwiftHarness } from "./_swift-harness.js";

/**
 * `runSwiftHarness` compiles a source set ONCE per file and runs it per call.
 *
 * Driven with a stub `xcrun` and `swiftc` on PATH, the way ticket-check.test.ts
 * stubs `gh`: the stub compiler logs one line per invocation and "compiles" to
 * a shell script, so this counts compiles directly and runs anywhere. Every
 * test uses its own source list, because the cache is module state shared by
 * the whole file.
 */
let stubs: string;
let compileLog: string;
let savedPath: string | undefined;

beforeAll(() => {
  stubs = mkdtempSync(join(tmpdir(), "stc-swiftc-stub-"));
  compileLog = join(stubs, "compiles");
  writeFileSync(join(stubs, "xcrun"), "#!/bin/sh\necho /stub-sdk\n");
  // Fails on demand, so eviction can be watched: STUB_SWIFTC_FAIL names a file
  // whose existence makes the compile fail.
  writeFileSync(join(stubs, "swiftc"), `#!/bin/sh
echo "$*" >> "${compileLog}"
if [ -n "$STUB_SWIFTC_FAIL" ] && [ -e "$STUB_SWIFTC_FAIL" ]; then echo "stub compile error" >&2; exit 1; fi
while [ "$1" != "-o" ]; do shift; done
printf '#!/bin/sh\\necho "ALL PASS run=$STUB_RUN"\\n' > "$2"
chmod +x "$2"
`);
  chmodSync(join(stubs, "xcrun"), 0o755);
  chmodSync(join(stubs, "swiftc"), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${stubs}:${savedPath}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
});

const compilesOf = (source: string) =>
  existsSync(compileLog)
    ? readFileSync(compileLog, "utf8").split("\n").filter((l) => l.includes(source)).length
    : 0;

describe("runSwiftHarness compiles once per source set", () => {
  test("two calls over the same sources compile once and run twice, each with its own env", async () => {
    const sources = ["helper/test/stub-a/main.swift"];
    const first = await runSwiftHarness({ label: "stub-a", sources, env: { STUB_RUN: "1" } });
    const second = await runSwiftHarness({ label: "stub-a-other", sources, env: { STUB_RUN: "2" } });

    expect(first).toContain("ALL PASS run=1");
    expect(second).toContain("ALL PASS run=2");
    expect(compilesOf("stub-a/main.swift")).toBe(1);
  });

  test("concurrent callers share one compile", async () => {
    const sources = ["helper/test/stub-b/main.swift"];
    await Promise.all([1, 2, 3].map((n) =>
      runSwiftHarness({ label: "stub-b", sources, env: { STUB_RUN: String(n) } })));
    expect(compilesOf("stub-b/main.swift")).toBe(1);
  });

  test("a different source set is its own compile", async () => {
    await runSwiftHarness({ label: "stub-c", sources: ["helper/test/stub-c/main.swift"] });
    await runSwiftHarness({ label: "stub-c", sources: ["helper/test/stub-c/main.swift", "helper/src/Extra.swift"] });
    expect(compilesOf("stub-c/main.swift")).toBe(2);
  });

  test("a failed compile is not cached: the next call compiles again", async () => {
    const sources = ["helper/test/stub-d/main.swift"];
    const failFlag = join(stubs, "fail-d");
    writeFileSync(failFlag, "");
    process.env.STUB_SWIFTC_FAIL = failFlag;
    try {
      await expect(runSwiftHarness({ label: "stub-d", sources })).rejects.toThrow(/swiftc exited 1/);
    } finally {
      delete process.env.STUB_SWIFTC_FAIL;
    }
    await expect(runSwiftHarness({ label: "stub-d", sources })).resolves.toContain("ALL PASS");
    expect(compilesOf("stub-d/main.swift")).toBe(2);
  });
});
