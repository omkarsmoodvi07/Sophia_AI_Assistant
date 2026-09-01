/**
 * The one number that connects Sophia's voice to Sophia's mouth.
 *
 * `useSophiaVoice` (owned by the chat pane) writes it from the audio analyser;
 * the avatar's render loop reads it every frame. They live in completely
 * different parts of the component tree, and threading a prop between them
 * would mean touching chat-pane's template, the avatar's props, and every
 * component in between — for a value that changes 60 times a second and that
 * Vue's reactivity would then have to diff on every single frame.
 *
 * A module-level plain object is a better fit: ES modules are singletons, so
 * both sides get the same object, and a raw property write costs nothing. It is
 * deliberately NOT a ref — nothing needs to *react* to this, the render loop
 * already samples it once per frame.
 */
export const mouth = {
  /** 0 = closed, 1 = wide open. Smoothed RMS of whatever is currently playing. */
  level: 0,
}

export function setMouthLevel(value: number): void {
  const n = Number(value)
  mouth.level = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
}
