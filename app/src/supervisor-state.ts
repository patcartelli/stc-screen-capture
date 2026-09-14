/**
 * Split out of `supervisor.ts` (STC-375), the same reason `library-items.ts`
 * split from `library.ts`: `pill.ts` needs this type and is imported by
 * `renderer.ts`, which `tsconfig.browser.json` typechecks — and that pass
 * follows even a TYPE-ONLY import into the file that declares it. Importing
 * straight from `supervisor.ts` would pull its real `import` of
 * `helper-client.ts` (node child_process) into the browser pass and fail on
 * code that has nothing to do with the type being borrowed. This file has
 * nothing in it but the type, so it is safe to be reached from either side.
 */
export type SupervisorState = "starting" | "idle" | "recording" | "failed" | "stopped";
