/**
 * The release's signing and notarization decisions (STC-508b), kept apart from
 * `release-dmg.mjs` so they can be tested without a keychain, a network or an
 * Apple account. This module runs nothing.
 *
 * A release is signed with Developer ID or it does not ship: a self-signed
 * .dmg is quarantined and refused by Gatekeeper on a clean Mac, which is the
 * whole reason STC-515 exists. So none of these functions FALL BACK. No
 * identity, two identities and no choice, or a notary result that is anything
 * but "Accepted" are all refusals with a sentence saying what to do.
 */

const PREFIX = "Developer ID Application:";

/** Every Developer ID Application identity in `security find-identity` output. */
export function parseDeveloperIds(findIdentityOutput) {
  const ids = [];
  for (const line of findIdentityOutput.split("\n")) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/);
    if (m && m[2].startsWith(PREFIX)) ids.push({ hash: m[1], name: m[2] });
  }
  // The same cert listed under two keychains is one identity.
  return ids.filter((id, i) => ids.findIndex((o) => o.hash === id.hash) === i);
}

/**
 * Which identity signs the release. `override` is RELEASE_SIGN_ID: a full name
 * or a SHA-1 hash. Throws rather than guessing, because the wrong guess is a
 * release signed by the wrong team.
 */
export function pickReleaseIdentity(ids, override) {
  if (override) {
    const hit = ids.find((id) => id.name === override || id.hash === override.toUpperCase());
    if (!hit) {
      throw new Error(
        `RELEASE_SIGN_ID "${override}" is not a Developer ID Application identity in the keychain. ` +
          `Found: ${ids.map((i) => i.name).join(", ") || "none"}.`,
      );
    }
    return hit;
  }
  if (ids.length === 0) {
    throw new Error(
      'No "Developer ID Application" identity found (security find-identity -v -p codesigning). ' +
        "A release is never signed with the self-signed STC Dev Signing; see STC-515.",
    );
  }
  if (ids.length > 1) {
    throw new Error(
      `${ids.length} Developer ID identities found (${ids.map((i) => i.name).join("; ")}). ` +
        "Set RELEASE_SIGN_ID to the one to use.",
    );
  }
  return ids[0];
}

/** electron-builder wants the name WITHOUT the "Developer ID Application:" prefix. */
export function builderIdentityName(fullName) {
  return fullName.startsWith(PREFIX) ? fullName.slice(PREFIX.length).trim() : fullName;
}

/**
 * Read `notarytool submit --output-format json`. Returns the submission id and
 * whether Apple accepted it. Anything unparseable is NOT accepted: a result we
 * cannot read must not read as a pass.
 */
export function parseNotarySubmission(stdout) {
  let doc;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { id: undefined, status: "unreadable", accepted: false };
  }
  const status = typeof doc.status === "string" ? doc.status : "unreadable";
  return { id: typeof doc.id === "string" ? doc.id : undefined, status, accepted: status === "Accepted" };
}

/** The sentence a failed notarization ends on, with the command that says why. */
export function notaryFailureMessage(sub, profile) {
  const why = sub.id
    ? `Why: xcrun notarytool log ${sub.id} --keychain-profile "${profile}"`
    : "No submission id came back, so there is no log to fetch.";
  return `Notarization did not succeed (status: ${sub.status}). ${why}`;
}
