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
