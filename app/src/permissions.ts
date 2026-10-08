/**
 * The required-grants panel's decisions (STC-476 MVP slice, with STC-518).
 * Pure — no Electron, no DOM — because main decides and the renderer draws,
 * and both need the row shape.
 *
 * 1. Two rows, and only two: Screen Recording and Input Monitoring. Both are
 *    required. Without Screen Recording nothing is captured, and without Input
 *    Monitoring a take has no cursor anywhere, which the helper already
 *    refuses (STC-315/480). Mic and camera rows are STC-520.
 * 2. The helper reads and requests both (`Permissions.swift`). Electron has no
 *    Input Monitoring API, and the ticket asks for one place, not two.
 * 3. Screen Recording takes effect only after a relaunch. A grant that arrived
 *    during this run is shown as "relaunch", never as "granted". A request
 *    made this run also offers Relaunch, because the helper's
 *    `CGPreflightScreenCaptureAccess` may not see a mid-run grant at all.
 * 4. Accessibility also feeds the event tap (`decideEventTapAccess`), so a
 *    machine recording through it today has Input Monitoring's row granted.
 *    Asking it for a second grant would be asking for nothing.
 * 5. A report that could not be read is NOT a panel. An old or missing
 *    helper fails open. The helper's own refusals still cover the take.
 * 6. A shot needs Screen Recording only. A Record needs both.
 */

import { TOAST_ACTION_URLS } from "./toast-message.js";

export type Grant = "screen-recording" | "input-monitoring";
export type ListenEvent = "granted" | "denied" | "unknown";

/** The helper's `permissions` reply. */
export interface PermissionsReport {
  screenRecording: boolean;
  inputMonitoring: ListenEvent;
  accessibility: boolean;
}

/** What this run of the app remembers between checks. */
export interface PermissionsMemory {
  /** Screen Recording at this run's first successful check. */
  screenAtLaunch: boolean | null;
  /** Grants a request was sent for during this run. */
  requested: ReadonlySet<Grant>;
}

export type RowStatus = "granted" | "not-yet" | "denied" | "relaunch";
export type RowAction = "request" | "open-settings" | "relaunch";

export interface PermissionRow {
  grant: Grant;
  title: string;
  why: string;
  status: RowStatus;
  statusText: string;
  actions: RowAction[];
}

export interface PermissionsState {
  needed: boolean;
  rows: PermissionRow[];
}

export const SETTINGS_URLS: Record<Grant, string> = {
  "screen-recording": TOAST_ACTION_URLS["open-screen-recording-settings"],
  "input-monitoring": TOAST_ACTION_URLS["open-input-monitoring-settings"],
};

export const PERMISSION_ACTION_LABELS: Record<RowAction, string> = {
  request: "Grant…",
  "open-settings": "Open System Settings",
  relaunch: "Relaunch Capture",
};

/** Refuses anything that is not exactly the helper's reply (rule 5). */
export function parsePermissions(line: unknown): PermissionsReport | null {
  if (!line || typeof line !== "object") return null;
  const l = line as Record<string, unknown>;
  if (l.ev !== "permissions") return null;
  if (typeof l.screenRecording !== "boolean" || typeof l.accessibility !== "boolean") return null;
  if (l.inputMonitoring !== "granted" && l.inputMonitoring !== "denied" && l.inputMonitoring !== "unknown") return null;
  return { screenRecording: l.screenRecording, inputMonitoring: l.inputMonitoring, accessibility: l.accessibility };
}

function screenRow(r: PermissionsReport, m: PermissionsMemory): PermissionRow {
  const base = {
    grant: "screen-recording" as const,
    title: "Screen & System Audio Recording",
    why: "Capture records your screen with it. Nothing can be captured without it.",
  };
  if (r.screenRecording && m.screenAtLaunch !== false) {
    return { ...base, status: "granted", statusText: "Granted", actions: [] };
  }
  if (r.screenRecording) {
    return { ...base, status: "relaunch", statusText: "Granted. Relaunch Capture to start using it.",
             actions: ["relaunch"] };
  }
  if (m.requested.has("screen-recording")) {
    return { ...base, status: "denied",
             statusText: "Turn on Capture in System Settings, then relaunch.",
             actions: ["open-settings", "relaunch"] };
  }
  return { ...base, status: "not-yet", statusText: "Not granted yet", actions: ["request"] };
}

function inputRow(r: PermissionsReport, m: PermissionsMemory): PermissionRow {
  const base = {
    grant: "input-monitoring" as const,
    title: "Input Monitoring",
    why: "Capture draws the pointer, clicks and auto-zoom from it. A recording without it has no cursor, so Capture won't record without it.",
  };
  if (r.inputMonitoring === "granted" || r.accessibility) {
    return { ...base, status: "granted", statusText: "Granted", actions: [] };
  }
  if (r.inputMonitoring === "denied" || m.requested.has("input-monitoring")) {
    return { ...base, status: "denied", statusText: "Turn on Capture in System Settings.",
             actions: ["open-settings"] };
  }
  return { ...base, status: "not-yet", statusText: "Not granted yet", actions: ["request"] };
}

/** The panel for one report. `null` (unreadable) is never a panel (rule 5). */
export function permissionsState(r: PermissionsReport | null, m: PermissionsMemory): PermissionsState {
  if (!r) return { needed: false, rows: [] };
  const rows = [screenRow(r, m), inputRow(r, m)];
  return { needed: rows.some((row) => row.status !== "granted"), rows };
}

/** Does this state stop a capture before its overlay opens? (rule 6) */
export function blocksCapture(s: PermissionsState, kind: "record" | "still"): boolean {
  return s.rows.some((row) => row.status !== "granted"
    && (kind === "record" || row.grant === "screen-recording"));
}

/** Folds one report into this run's memory: the first one sets the launch state. */
export function remember(m: PermissionsMemory, r: PermissionsReport | null): PermissionsMemory {
  if (!r || m.screenAtLaunch !== null) return m;
  return { ...m, screenAtLaunch: r.screenRecording };
}

export function isGrant(v: unknown): v is Grant {
  return v === "screen-recording" || v === "input-monitoring";
}

export function isRowAction(v: unknown): v is RowAction {
  return v === "request" || v === "open-settings" || v === "relaunch";
}
