import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AjvImport from "ajv";
import { parseCaptureDoc, captureDocForWrite } from "../src/capture-doc.js";
import { mintCaptureId } from "../src/capture-id.js";

const Ajv = (AjvImport as any).default ?? AjvImport;
const root = join(__dirname, "..", "..");
const schema = JSON.parse(readFileSync(join(root, "schema/capture-1.schema.json"), "utf8"));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

describe("capture-1 schema and loader agree", () => {
  test("a written document validates and round trips", () => {
    const id = mintCaptureId();
    const doc = captureDocForWrite(id);
    expect(validate(doc)).toBe(true);
    expect(parseCaptureDoc(doc).id).toBe(id);
  });

  test("the loader REFUSES rather than defaulting", () => {
    for (const bad of [
      {}, null, "nope", { version: 1 }, { id: mintCaptureId() },
      { version: 2, id: mintCaptureId() },
      { version: 1, id: "not-an-id" },
      { version: 1, id: mintCaptureId(), extra: true },   // noExtra, like parseShot
    ]) {
      expect(() => parseCaptureDoc(bad)).toThrow();
    }
  });
});
