/**
 * Runs `scrubPackagedEnv` (seams.ts, STC-657) as an import side effect.
 *
 * `main.ts` imports this FIRST. ES modules evaluate in import order, so every
 * other module `main.ts` pulls in, and `main.ts`'s own body, sees an
 * environment with no `STC_*` seam in a packaged build. Calling it from the
 * body of `main.ts` instead would run it AFTER those imports' top-level code.
 */
import { app } from "electron";
import { scrubPackagedEnv } from "./seams.js";

const ignored = scrubPackagedEnv(process.env, app.isPackaged);
if (ignored.length > 0) console.error(`[seams] packaged build ignores ${ignored.join(", ")}`);
