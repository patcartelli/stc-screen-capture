/**
 * What a microphone IS, and what it is called — the one owner of both.
 *
 * Lifted out of `renderer.ts` by STC-388, which gave the options bar a second
 * mic control. The window's picker and the bar must name one device
 * identically, and a Bluetooth suffix written out twice in two files is
 * CLAUDE.md's worst variant of the copy trap: "a filename built in the renderer
 * and looked for in main … because no typecheck can see the pair."
 */

/** STC-233. Mirrors `Watchers.enumerateDevices`'s own "mics" shape. */
export interface MicInfo {
  name: string; uid: string; bluetooth: boolean;
}

/**
 * Bluetooth is called out because it is the class of device that once stalled
 * capture and wedged CoreAudio system-wide (phase 0) — a user picking one
 * should know that is what they are picking.
 */
export function micLabel(m: MicInfo): string {
  return m.bluetooth ? `${m.name} (Bluetooth)` : m.name;
}
