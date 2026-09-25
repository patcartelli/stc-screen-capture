import { build } from "esbuild";
const alias = { "@transform": new URL("../transform/src", import.meta.url).pathname };
const common = {
  bundle: true, platform: "node", target: "node20", external: ["electron"], logLevel: "warning",
  alias,
};
await build({ ...common, entryPoints: ["app/src/main.ts"], outfile: "app/dist/main.mjs", format: "esm" });
await build({ ...common, entryPoints: ["app/src/preload.ts"], outfile: "app/dist/preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/renderer.ts"], outfile: "app/dist/renderer.js", format: "iife", platform: "browser" });
// The selection overlay (STC-290) is its own window with its own, smaller
// bridge — it reads nothing and writes nothing, so it must not load the main
// window's preload.
await build({ ...common, entryPoints: ["app/src/overlay-preload.ts"], outfile: "app/dist/overlay-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/overlay.ts"], outfile: "app/dist/overlay.js", format: "iife", platform: "browser" });
// The post-capture floating thumbnail (STC-296) — its own window, its own
// smaller bridge, for the same reason the overlay's is separate.
await build({ ...common, entryPoints: ["app/src/thumbnail-preload.ts"], outfile: "app/dist/thumbnail-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/thumbnail-renderer.ts"], outfile: "app/dist/thumbnail-renderer.js", format: "iife", platform: "browser" });
// The editor (STC-373) — preview/trim/export/legibility/share's own window,
// its own smaller bridge, for the same reason the overlay's and the
// thumbnail's are separate.
await build({ ...common, entryPoints: ["app/src/editor-preload.ts"], outfile: "app/dist/editor-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/editor.ts"], outfile: "app/dist/editor.js", format: "iife", platform: "browser" });
// STC-454: the preview's narration cleanup, off the editor's main thread.
await build({ ...common, entryPoints: ["app/src/narration-worker.ts"], outfile: "app/dist/narration-worker.js", format: "iife", platform: "browser" });
// The countdown (STC-391) — Record's countdown and Capture's self-timer are
// one surface, in its own window with its own, narrowest bridge.
await build({ ...common, entryPoints: ["app/src/countdown-preload.ts"], outfile: "app/dist/countdown-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/countdown-renderer.ts"], outfile: "app/dist/countdown-renderer.js", format: "iife", platform: "browser" });
// The undo toast (STC-392 Task 6) — its own window, its own narrowest bridge,
// the same reason every other floating surface above is separate.
await build({ ...common, entryPoints: ["app/src/toast-preload.ts"], outfile: "app/dist/toast-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/toast-renderer.ts"], outfile: "app/dist/toast-renderer.js", format: "iife", platform: "browser" });
// The still editor (STC-300) — its own window, its own narrowest bridge, the
// same reason every other floating surface above is separate.
await build({ ...common, entryPoints: ["app/src/still-editor-preload.ts"], outfile: "app/dist/still-editor-preload.cjs", format: "cjs" });
await build({ ...common, entryPoints: ["app/src/still-editor-renderer.ts"], outfile: "app/dist/still-editor-renderer.js", format: "iife", platform: "browser" });
console.log("app built -> app/dist/");
