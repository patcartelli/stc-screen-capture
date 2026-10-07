import { describe, test, expect } from "vitest";
// @ts-expect-error — plain .mjs script module, no declaration file
import * as sign from "../../scripts/release-sign.mjs";

/**
 * The release must never be signed by accident with the wrong thing. Each test
 * is a way the picker could hand back an identity (or a "pass") it should not.
 */
const DEV = '  1) D9EA4803BB048060EB87E3EF6BF50D9A1ABAB52C "STC Dev Signing"';
const APPLE_DEV =
  '  2) 277F7ACB2E691E25CBAD5312B74938022266B22D "Apple Development: Patrick Cartelli (45VMX3Q9YN)"';
const DEVID =
  '  3) 5F47C1B598574067CE2AE667402F9E96CAD4734B "Developer ID Application: Patrick Cartelli (6TV2WVR5YT)"';
const OTHER =
  '  4) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "Developer ID Application: Someone Else (ZZZZZZZZZZ)"';
const out = (...lines: string[]) => `Policy: Code Signing\n  Matching identities\n${lines.join("\n")}\n     ${lines.length} identities found\n`;

describe("parseDeveloperIds", () => {
  test("ignores the self-signed and Apple Development identities", () => {
    const ids = sign.parseDeveloperIds(out(DEV, APPLE_DEV, DEVID));
    expect(ids).toEqual([
      { hash: "5F47C1B598574067CE2AE667402F9E96CAD4734B", name: "Developer ID Application: Patrick Cartelli (6TV2WVR5YT)" },
    ]);
  });
  test("a cert listed in two keychains is one identity", () => {
    expect(sign.parseDeveloperIds(out(DEVID, DEVID))).toHaveLength(1);
  });
  test("a Developer ID Installer cert is not an Application cert", () => {
    const installer = DEVID.replace("Application", "Installer");
    expect(sign.parseDeveloperIds(out(installer))).toEqual([]);
  });
});

describe("pickReleaseIdentity", () => {
  const one = sign.parseDeveloperIds(out(DEV, DEVID));
  const two = sign.parseDeveloperIds(out(DEVID, OTHER));
  test("one identity is chosen", () => {
    expect(sign.pickReleaseIdentity(one).name).toContain("6TV2WVR5YT");
  });
  test("none is a refusal, never a fallback to the self-signed cert", () => {
    expect(() => sign.pickReleaseIdentity([])).toThrow(/never signed with the self-signed/);
  });
  test("two without a choice is a refusal", () => {
    expect(() => sign.pickReleaseIdentity(two)).toThrow(/RELEASE_SIGN_ID/);
  });
  test("an override picks by name or by hash, case-insensitively for the hash", () => {
    expect(sign.pickReleaseIdentity(two, "Developer ID Application: Someone Else (ZZZZZZZZZZ)").hash).toMatch(/^A+$/);
    expect(sign.pickReleaseIdentity(two, "5f47c1b598574067ce2ae667402f9e96cad4734b").name).toContain("Patrick");
  });
  test("an override that names something else (the self-signed cert) is a refusal", () => {
    expect(() => sign.pickReleaseIdentity(one, "STC Dev Signing")).toThrow(/not a Developer ID Application/);
  });
});

describe("builderIdentityName", () => {
  test("strips the prefix electron-builder adds itself", () => {
    expect(sign.builderIdentityName("Developer ID Application: Patrick Cartelli (6TV2WVR5YT)")).toBe(
      "Patrick Cartelli (6TV2WVR5YT)",
    );
  });
});

describe("parseNotarySubmission", () => {
  test("Accepted is accepted", () => {
    expect(sign.parseNotarySubmission('{"id":"abc","status":"Accepted"}')).toEqual({ id: "abc", status: "Accepted", accepted: true });
  });
  test("Invalid and In Progress are not", () => {
    expect(sign.parseNotarySubmission('{"id":"abc","status":"Invalid"}').accepted).toBe(false);
    expect(sign.parseNotarySubmission('{"id":"abc","status":"In Progress"}').accepted).toBe(false);
  });
  test("output we cannot read is not a pass", () => {
    expect(sign.parseNotarySubmission("Error: network down").accepted).toBe(false);
    expect(sign.parseNotarySubmission("{}").accepted).toBe(false);
    expect(sign.parseNotarySubmission('{"status":"accepted"}').accepted).toBe(false);
  });
  test("the failure sentence names the log command when there is an id", () => {
    const msg = sign.notaryFailureMessage({ id: "abc", status: "Invalid" }, "capture");
    expect(msg).toContain('notarytool log abc --keychain-profile "capture"');
  });
});
