import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const load = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(load("schema/events-3.schema.json"));
const doc = (...events: object[]) => ({ version: 3, events });
const key = (k: string, mods: string[] = []) => ({ t: 1000, kind: "key", key: k, mods });

describe("events-3 (STC-419)", () => {
  test("accepts named keys and chords alongside v2 events", () => {
    const ok = validate(doc(
      { t: 0, kind: "move", x: 1, y: 2 },
      { t: 5, kind: "cursor", shape: "ibeam" },
      key("ArrowDown"), key("Tab", ["shift"]), key("ArrowLeft", ["opt"]),
      key("K", ["cmd"]), key("F", ["ctrl", "cmd"]), key("4", ["shift", "cmd"]),
    ));
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test.each([
    ["a bare letter", key("A")],
    ["a shift-only letter", key("A", ["shift"])],
    ["an opt-only letter", key("E", ["opt"])],
    ["a lowercase chord char", key("k", ["cmd"])],
    ["a space chord", key(" ", ["cmd"])],
    ["an unknown named key", key("CapsLock")],
    ["an unknown mod", key("K", ["hyper"])],
    ["a repeated mod", key("K", ["cmd", "cmd"])],
  ])("refuses %s", (_name, ev) => {
    expect(validate(doc(ev))).toBe(false);
  });

  test("the enum is exactly keycast.ts's NAMED_KEYS, in order", async () => {
    const { NAMED_KEYS } = await import("../src/keycast.js");
    const schema = load("schema/events-3.schema.json");
    expect(schema.definitions.keyEvent.properties.key.anyOf[0].enum).toEqual([...NAMED_KEYS]);
  });
});
