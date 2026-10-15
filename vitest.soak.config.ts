import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * STC-238's fault soak. `npm run test:soak`.
 *
 * Its own config, not test:capture's, for two reasons. It is slow — every case
 * ends in a real Chrome export — so a routine grant run should not pay for it.
 * And it needs MORE than test:capture: Camera as well as Screen Recording and
 * Input Monitoring, plus Chrome. Like test:capture it never runs on CI, which
 * has none of those, and it is scoped to the real test directories for the
 * same reason that config's comment gives (the agent worktrees).
 */
export default defineConfig({
  resolve: {
    alias: { "@transform": fileURLToPath(new URL("./transform/src", import.meta.url)) },
  },
  test: {
    include: [
      "transform/test/**/*.soak.test.ts",
      "helper/test/**/*.soak.test.ts",
      "app/test/**/*.soak.test.ts",
    ],
    exclude: ["**/node_modules/**"],
    // One helper, one ScreenCaptureKit stream, one export server port at a time.
    fileParallelism: false,
    testTimeout: 240_000,
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
