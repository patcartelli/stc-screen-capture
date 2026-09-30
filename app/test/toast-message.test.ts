import { describe, test, expect } from "vitest";
import {
  parseToastMessage, toToastMessage, toastMessageText, isToastActionId, TOAST_ACTION_URLS,
} from "../src/toast-message.js";
import {
  fitMessageHeight, messageToastMs, MESSAGE_TOAST_SIZE, MESSAGE_TOAST_MIN_HEIGHT,
  TOAST_CARD_INSET_PX, MESSAGE_TOAST_MIN_MS,
} from "../src/toast.js";

/** STC-457: the structured message and the content-sized window. */
describe("a toast message", () => {
  test("a plain string is a body-only message", () => {
    expect(toToastMessage("hi")).toEqual({ body: "hi" });
    expect(toastMessageText("hi")).toBe("hi");
  });

  test("text is the title, a newline, then the body", () => {
    expect(toastMessageText({ title: "T", body: "B" })).toBe("T\nB");
  });

  test("parse accepts a string, and a full message", () => {
    expect(parseToastMessage("x")).toEqual({ body: "x" });
    const m = { title: "T", body: "B", action: { id: "open-screen-recording-settings", label: "Open" } };
    expect(parseToastMessage(m)).toEqual(m);
  });

  test("parse refuses what is not a message", () => {
    for (const bad of [undefined, null, 5, "", {}, { body: "" }, { body: 3 },
      { body: "b", title: "" }, { body: "b", title: 1 },
      { body: "b", action: "x" }, { body: "b", action: null }]) {
      expect(parseToastMessage(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  test("parse refuses an action id it does not know, or a missing label", () => {
    expect(parseToastMessage({ body: "b", action: { id: "open-anything", label: "x" } })).toBeUndefined();
    expect(parseToastMessage({ body: "b", action: { id: "open-screen-recording-settings", label: "" } })).toBeUndefined();
    // Own keys only — `toString` is on every object's prototype.
    expect(isToastActionId("toString")).toBe(false);
    expect(isToastActionId("__proto__")).toBe(false);
  });

  test("every action opens a System Settings pane", () => {
    for (const url of Object.values(TOAST_ACTION_URLS)) {
      expect(url).toMatch(/^x-apple\.systempreferences:/);
    }
  });

  test("parse drops extra fields rather than passing them on", () => {
    expect(parseToastMessage({ body: "b", url: "https://evil.example" })).toEqual({ body: "b" });
  });
});

describe("the message toast's height", () => {
  test("fits the card plus the gutter", () => {
    expect(fitMessageHeight(120)).toBe(120 + 2 * TOAST_CARD_INSET_PX);
  });

  test("rounds a fractional card UP", () => {
    expect(fitMessageHeight(100.2)).toBe(101 + 2 * TOAST_CARD_INSET_PX);
  });

  test("never shorter than the undo toast, never taller than the ceiling", () => {
    expect(fitMessageHeight(10)).toBe(MESSAGE_TOAST_MIN_HEIGHT);
    expect(fitMessageHeight(10_000)).toBe(MESSAGE_TOAST_SIZE.height);
  });

  test("a measurement that is not a number falls back to the ceiling", () => {
    expect(fitMessageHeight(NaN)).toBe(MESSAGE_TOAST_SIZE.height);
    expect(fitMessageHeight(Number(undefined))).toBe(MESSAGE_TOAST_SIZE.height);
  });
});

describe("how long a message stays up", () => {
  test("counts the title as well as the body", () => {
    expect(messageToastMs({ title: "T".repeat(100), body: "b" }))
      .toBeGreaterThan(messageToastMs({ body: "b" }));
    expect(messageToastMs("x")).toBeGreaterThanOrEqual(MESSAGE_TOAST_MIN_MS);
  });
});
