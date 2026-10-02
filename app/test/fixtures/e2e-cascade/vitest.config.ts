import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// See hangs.fixture.ts. STC_E2E_DIAG_DIR comes from the spawning test's env.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["hangs.fixture.ts"],
    setupFiles: [fileURLToPath(new URL("../../_e2e-setup.ts", import.meta.url))],
  },
});
