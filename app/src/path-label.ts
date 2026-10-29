/**
 * A folder as the Export section shows it (STC-604): the user's home folder as
 * `~`, the rest untouched. The renderer has no home directory to ask, and the
 * take's own path starts with it on every Mac, so the shape is enough:
 * `/Users/<name>` at the start, followed by a slash or the end.
 *
 * Display only. Nothing is parsed back out of this, and the full path stays
 * in the tooltip.
 */
export function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}
