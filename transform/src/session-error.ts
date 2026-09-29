/**
 * Split out of session.ts (STC-235) so display-geometry.ts can throw the same
 * error class without a circular import: session.ts calls checkGeometry, and
 * checkGeometry needs to throw SessionLoadError. session.ts re-exports this
 * so every existing `from "./session.js"` import keeps working unchanged.
 */
export class SessionLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLoadError";
  }
}
