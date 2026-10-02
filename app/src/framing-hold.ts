import type { Framing } from "@transform/framing";

/**
 * Framing set aside while a zoom-override editor is open (STC-396).
 *
 * The override editor maps a pointer on the stage to capture UV, which is only
 * true when the picture fills the canvas. With a frame the picture is inset,
 * so the editor presents the project WITHOUT its framing (the same trick it
 * plays on the window's own override) and remembers it here. No DOM, no
 * Electron.
 *
 * Generic over "anything with a framing field" rather than naming `Project`:
 * trim.test.ts's one-parser tripwire greps `app/src` for a declared Project.
 */
export interface FramingHold { framing: Framing }

type Framed = { framing?: Framing };

/** Take framing off `project` (mutating it, as the editor's live project is) and return what to restore; null when there was none. */
export function holdFraming(project: Framed): FramingHold | null {
  if (!project.framing) return null;
  const hold = { framing: project.framing };
  delete project.framing;
  return hold;
}

/** Put a held framing back. Safe with a null hold. */
export function restoreFraming(project: Framed, hold: FramingHold | null): void {
  if (hold) project.framing = hold.framing;
}

/** The project as it must be WRITTEN or EXPORTED: the live project with any held framing back on. A copy; the live project is untouched. */
export function withHeldFraming<P extends Framed>(project: P, hold: FramingHold | null): P {
  return hold ? { ...project, framing: hold.framing } : project;
}

/** The framing the user has chosen, whether or not it is currently set aside. */
export function chosenFraming(project: Framed | undefined, hold: FramingHold | null): Framing | undefined {
  return hold ? hold.framing : project?.framing;
}
