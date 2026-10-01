/**
 * A capture's stable identity, embedded in the media file it produced
 * (STC-413).
 *
 * Opaque on purpose: no timestamp, no path, no user data. It exists only to
 * point a finished file back at its source bundle in `raw/`, so it must be
 * safe to embed in a file the user may share — which is also why
 * `stripMetadata` does not suppress it.
 *
 * Its own module so the shape and its validation have exactly ONE owner. This
 * repo's most-repeated defect is one value with two copies.
 */

/** Crockford base32: no I, L, O or U, so a transcribed id cannot be ambiguous. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PREFIX = "cap_";
const BODY_LENGTH = 26;

export const CAPTURE_ID_LENGTH = PREFIX.length + BODY_LENGTH;

const PATTERN = new RegExp(`^${PREFIX}[${ALPHABET}]{${BODY_LENGTH}}$`);

/**
 * `random` is injected rather than reached for, so a test can pin the output.
 * Math.random is not cryptographic and does not need to be: this is a
 * collision-avoidance token within one user's folder, not a secret.
 */
export function mintCaptureId(random: () => number = Math.random): string {
  let body = "";
  for (let i = 0; i < BODY_LENGTH; i++) {
    body += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? ALPHABET[0];
  }
  return PREFIX + body;
}

export function isCaptureId(v: unknown): v is string {
  return typeof v === "string" && PATTERN.test(v);
}

/** Is this byte one a capture id's body may contain? Crockford base32. */
const ID_BODY_BYTE = (() => {
  const ok = new Uint8Array(256);
  for (const c of ALPHABET) ok[c.charCodeAt(0)] = 1;
  return ok;
})();

/**
 * Every capture-id-shaped token in a run of bytes, in order of appearance.
 *
 * Deliberately a SCAN rather than a parse, and it lives here, beside the
 * shape it gates on, because two callers need it: `media-tag.ts` reads an id
 * out of XMP and HEIC bytes it has no parser for, and `capture-doc.ts`
 * salvages one out of a `capture.json` that no longer parses (STC-436). One
 * scanner, so the two cannot disagree about what an id looks like.
 *
 * What makes the scan safe is that it decides nothing: every candidate is
 * gated through `isCaptureId`, so the only strings it can yield are ones that
 * already match the exact `cap_` + 26-Crockford shape this module owns. A
 * 30-character token of that shape does not appear in a file by accident.
 *
 * The boundary check is the one subtlety: without it a LONGER run of
 * Crockford characters would have its first 30 read as an id. A candidate
 * must therefore not be followed by another body character — the id is a
 * whole token, never a prefix of something else.
 *
 * A generator so the media readers can stop at the first hit in a
 * multi-megabyte HEIC, while the salvage walks the whole (tiny) document.
 */
export function* captureIdTokens(data: Uint8Array): Generator<string> {
  for (let i = 0; i + CAPTURE_ID_LENGTH <= data.length; i++) {
    if (data[i] !== 0x63 || data[i + 1] !== 0x61       // "ca"
        || data[i + 2] !== 0x70 || data[i + 3] !== 0x5f) continue;   // "p_"
    const after = data[i + CAPTURE_ID_LENGTH];
    if (after !== undefined && ID_BODY_BYTE[after]) continue;
    const candidate = String.fromCharCode(...data.subarray(i, i + CAPTURE_ID_LENGTH));
    if (isCaptureId(candidate)) yield candidate;
  }
}
