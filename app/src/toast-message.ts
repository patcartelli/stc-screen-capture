/**
 * What a message toast is SAYING — the shape, and the one validator for it
 * (STC-457). No Electron, no DOM, no imports: `refusals.ts` builds these for
 * both processes, and `renderer.ts` is typechecked by the browser pass, which
 * follows even a type-only import into whatever it names.
 *
 * A message used to be one string, with a `\n` here and there. That gave the
 * toast nothing to lay out as a title, and no place to hang a button. It is
 * `{ title?, body, action? }` now. A plain string is still a valid message
 * (`toToastMessage`) and renders as body only — the ~30 free-form `alertUser`
 * callers did not need a title and did not get one.
 *
 * ## An action is an id, never a URL or a handler
 *
 * The renderer, and the toast page itself, may only NAME an action. What
 * that does is decided here (`TOAST_ACTION_URLS`, or for `reveal-saved-gif`
 * main's own handler) and carried out by main, so a message that crossed the
 * `toast:message` boundary cannot ask main to open an arbitrary address.
 * `parseToastMessage` refuses an id `TOAST_ACTION_IDS` does not have.
 */

/** Every action a toast may name — the one list `isToastActionId` checks. */
export const TOAST_ACTION_IDS = [
  "open-screen-recording-settings",
  "open-input-monitoring-settings",
  // STC-395: show the GIF Save just wrote. Main's own action, not a URL —
  // main remembers the file; the page can name the action, never the path.
  "reveal-saved-gif",
] as const;

export type ToastActionId = (typeof TOAST_ACTION_IDS)[number];

/** Actions that open a System Settings pane. "reveal-saved-gif" is main's, not a URL. */
export const TOAST_ACTION_URLS: Partial<Record<ToastActionId, string>> = {
  "open-screen-recording-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  "open-input-monitoring-settings":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
};

export interface ToastMessage {
  /** One short line. Absent for a free-form string: body only, no header. */
  title?: string;
  body: string;
  action?: { id: ToastActionId; label: string };
}

export type ToastInput = string | ToastMessage;

export function toToastMessage(m: ToastInput): ToastMessage {
  return typeof m === "string" ? { body: m } : m;
}

/** Everything a reader is shown, as one string — what length and tests read. */
export function toastMessageText(m: ToastInput): string {
  const { title, body } = toToastMessage(m);
  return title ? `${title}\n${body}` : body;
}

export function isToastActionId(id: unknown): id is ToastActionId {
  return typeof id === "string" && (TOAST_ACTION_IDS as readonly string[]).includes(id);
}

/**
 * A message from across an IPC boundary, or `undefined` if it is not one.
 * Refuses rather than repairs: a malformed message is dropped, not shown as
 * half a toast.
 */
export function parseToastMessage(x: unknown): ToastMessage | undefined {
  if (typeof x === "string") return x ? { body: x } : undefined;
  if (typeof x !== "object" || x === null) return undefined;
  const { title, body, action } = x as Record<string, unknown>;
  if (typeof body !== "string" || !body) return undefined;
  if (title !== undefined && (typeof title !== "string" || !title)) return undefined;
  const out: ToastMessage = { body };
  if (title !== undefined) out.title = title as string;
  if (action !== undefined) {
    if (typeof action !== "object" || action === null) return undefined;
    const { id, label } = action as Record<string, unknown>;
    if (!isToastActionId(id) || typeof label !== "string" || !label) return undefined;
    out.action = { id, label };
  }
  return out;
}
