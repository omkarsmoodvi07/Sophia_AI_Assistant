/**
 * Types for sophia-face.js.
 *
 * The sophia/* controllers are plain JavaScript, which normally means every
 * import of them lands as `any` and typos in method names go unnoticed until
 * runtime. This declaration buys back real checking on the face controller —
 * cheap, since it is the only one the render loop calls every frame.
 *
 * `headNode` is `unknown` on purpose: three.js ships no type declarations in
 * this project, so `THREE.Object3D` is not a nameable type here.
 */

/** Keys of MOOD_BLENDS. Anything else falls back to a warm resting face. */
export type SophiaMood =
  | 'idle'
  | 'warm'
  | 'happy'
  | 'laughing'
  | 'sad'
  | 'concerned'
  | 'angry'
  | 'surprised'
  | 'thinking'

export declare class SophiaFace {
  constructor(vrm: unknown)

  /** False when the model has no expressionManager; update() then no-ops. */
  enabled: boolean
  mood: string
  /** Logical expression name -> the name this particular model uses, or null. */
  resolved: Record<string, string | null>

  /**
   * How much of a clip's own head and neck tilt to cancel so she keeps looking
   * at the camera. 0 leaves the animation untouched, 1 forces dead level.
   * Adjustable live from the console via __sophiaGaze.
   */
  GAZE_LEVEL: number
  /**
   * Overall size of the continuous talking arm motion. 0 turns it off.
   * Adjustable live from the console via __sophiaGesture.
   */
  GESTURE_GAIN: number

  setMood(mood: SophiaMood | string): void
  /** 0 = closed, 1 = wide open. */
  setMouth(level: number): void
  /**
   * Turn the continuous talking-arm motion on or off. Driven by her speaking
   * state, not by mouth level — hands do not fall between sentences.
   */
  setTalking(on: boolean): void
  /** Call once per frame, after the animation mixer and before vrm.update(). */
  update(delta: number, headNode?: unknown): void
}
