/**
 * What a take's stop says to a person, on the panel and in the library (STC-505's copy
 * table). ONE mapping from `anchors.stop` to words, so the panel and the library cannot
 * describe the same stop two ways.
 *
 * STC-530 fills in one reason, `recorder-quit`. Every other reason returns `undefined`
 * here ON PURPOSE: STC-529 (library notes for an early stop) and STC-531 (the panel's
 * reason line) add their rows to these two functions rather than a second path.
 * `app/test/stop-copy.test.ts` walks every reason in the schema, so a row added here is
 * tested the moment it exists.
 *
 * Pure and node-free: `library-items.ts` (which the renderer typecheck pass follows)
 * imports it.
 */
export type StopBlock = { t?: number; reason?: string } | undefined;

export function panelReason(stop: StopBlock): string | undefined {
  switch (stop?.reason) {
    case "recorder-quit":
      return "Capture's recorder quit unexpectedly. This is what was saved before it stopped. Cursor and event data are missing.";
    default:
      return undefined;
  }
}

export function libraryNote(stop: StopBlock): string | undefined {
  switch (stop?.reason) {
    case "recorder-quit":
      return "Recovered after the recorder quit. No cursor data.";
    default:
      return undefined;
  }
}
