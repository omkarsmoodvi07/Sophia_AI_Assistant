/**
 * Sophia's face.
 *
 * Everything that made the reference videos feel human lives here, not in the
 * body animations. Watching those clips frame by frame, her torso barely moves
 * at all — what carries the emotion is four things:
 *
 *   1. Eyebrows. The signature look is *worried inner brows raised while the
 *      mouth is still smiling*. That single combination is most of the warmth.
 *      VRM has no brow control, but the `sad` preset raises the inner brows, so
 *      blending a little `sad` under a `happy` smile reproduces it exactly. See
 *      MOOD_BLENDS.warm — that mix is the whole trick.
 *   2. Blinking. A face that never blinks reads as a mannequin within seconds.
 *   3. A mouth that moves with the actual audio, not on a timer.
 *   4. Tiny, continuous head drift. Not turning — drifting, a couple of degrees.
 *
 * Defensive by design: VRM 0.x and VRM 1.0 use different expression names, and
 * a given model may implement only a handful of them. Every logical expression
 * is resolved against what this specific model actually has, and anything
 * missing is skipped rather than throwing. The resolved map is logged on load so
 * we can see exactly what Sophia.vrm supports.
 *
 * Plain JS on purpose, to match animation-controller.js and sophia-behaviour.js.
 */

// Logical name -> the names real VRM files use, best first. VRM 1.0 uses the
// lowercase presets; VRM 0.x models commonly ship joy/sorrow/fun and single
// letter visemes, and some exporters capitalise them.
const CANDIDATES = {
  happy: ['happy', 'joy', 'Joy', 'Happy', 'fun', 'Fun'],
  sad: ['sad', 'sorrow', 'Sorrow', 'Sad'],
  angry: ['angry', 'Angry'],
  relaxed: ['relaxed', 'fun', 'Fun', 'Relaxed'],
  surprised: ['surprised', 'Surprised'],
  blink: ['blink', 'Blink', 'blink_both', 'Blink_both'],
  aa: ['aa', 'a', 'A'],
  ih: ['ih', 'i', 'I'],
  ou: ['ou', 'u', 'U'],
  ee: ['ee', 'e', 'E'],
  oh: ['oh', 'o', 'O'],
}

const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh']

/**
 * Target weights per mood. Deliberately well under 1.0 in most cases — VRM
 * presets at full strength look like emoji. Restraint is what reads as a face.
 */
const MOOD_BLENDS = {
  // A resting face still has something going on, or she looks vacant.
  idle: { relaxed: 0.14 },
  // Attentive but not grinning: a hint of a smile, brows slightly engaged.
  warm: { happy: 0.34, sad: 0.14 },
  happy: { happy: 0.78, relaxed: 0.1 },
  // The eyes-squeezed-shut laugh from the first video.
  laughing: { happy: 1.0 },
  sad: { sad: 0.62 },
  // "Did I make you upset" — worried, but not crying.
  concerned: { sad: 0.34, relaxed: 0.08 },
  angry: { angry: 0.55 },
  surprised: { surprised: 0.72 },
  // Thinking should look inward, not pained.
  thinking: { relaxed: 0.2, sad: 0.1 },
}

// Blink timing, seconds. Humans blink every 2-8s and often twice in a row.
const BLINK_GAP_MIN = 2.4
const BLINK_GAP_MAX = 6.5
const BLINK_CLOSE_S = 0.055
const BLINK_HOLD_S = 0.025
const BLINK_OPEN_S = 0.12
const DOUBLE_BLINK_CHANCE = 0.22

/**
 * A non-accumulating additive layer over one bone.
 *
 * This class exists because of a real bug, and the bug is worth writing down so
 * nobody reintroduces it. Procedural motion has to be layered *on top of* the
 * animation mixer, not assigned over it, or it cancels whatever the clip does to
 * that bone. The obvious way to layer is `bone.rotation.x += offset` after the
 * mixer runs. That is wrong, and catastrophically so: the mixer only writes bones
 * the current clip actually animates. On every frame where the clip leaves a bone
 * alone, `+=` adds to *last frame's already-offset value*, so the offset
 * integrates. At 60fps a 0.04 rad term becomes ~2.4 rad per second and the avatar
 * rolls right over backwards within a second or two.
 *
 * The fix is to remember the exact value we wrote last frame. If the bone still
 * holds that value, the mixer did not touch it and our stored base is still the
 * base. If it holds anything else, the mixer overwrote it and that new value *is*
 * the base. Exact float comparison is correct here precisely because we wrote
 * that bit pattern ourselves — this is one of the few places `===` on floats is
 * the right tool rather than a smell. Note we compare but never subtract: storing
 * the base separately instead of recovering it as `current - lastOffset` means
 * there is no rounding residue to accumulate either.
 */
// How long the talking-body motion takes to ramp in and out, in seconds. Short
// enough to coincide with her first word, long enough that it does not snap on.
const TALK_BLEND_S = 0.45

/**
 * The always-moving offset applied to her arms while she speaks. See
 * updateTalkingBody().
 *
 * `a*` are amplitudes in radians, `f*` frequencies in radians/second, `p*` phase
 * offsets. The frequencies are deliberately not multiples of one another, so the
 * combined motion never visibly repeats. Left and right differ in both phase and
 * frequency, because two arms moving in perfect symmetry is the single most
 * robotic thing a talking figure can do.
 */
const ARM_SWAY = [
  { bone: 'leftUpperArm',  ax: 0.055, ay: 0.030, az: 0.070, fx: 0.83, fy: 0.61, fz: 0.47, px: 0.0,  py: 1.1, pz: 0.5 },
  { bone: 'rightUpperArm', ax: 0.055, ay: 0.030, az: 0.070, fx: 0.71, fy: 0.53, fz: 0.59, px: 2.2,  py: 0.3, pz: 3.1 },
  { bone: 'leftLowerArm',  ax: 0.090, ay: 0.050, az: 0.060, fx: 1.13, fy: 0.79, fz: 0.67, px: 0.7,  py: 2.0, pz: 1.4 },
  { bone: 'rightLowerArm', ax: 0.090, ay: 0.050, az: 0.060, fx: 1.03, fy: 0.89, fz: 0.73, px: 2.9,  py: 0.9, pz: 2.6 },
  { bone: 'leftHand',      ax: 0.110, ay: 0.070, az: 0.080, fx: 1.47, fy: 1.09, fz: 0.91, px: 1.3,  py: 2.7, pz: 0.2 },
  { bone: 'rightHand',     ax: 0.110, ay: 0.070, az: 0.080, fx: 1.31, fy: 1.19, fz: 0.97, px: 3.4,  py: 1.5, pz: 2.1 },
  { bone: 'leftShoulder',  ax: 0.018, ay: 0.014, az: 0.020, fx: 0.43, fy: 0.31, fz: 0.37, px: 0.9,  py: 1.8, pz: 2.4 },
  { bone: 'rightShoulder', ax: 0.018, ay: 0.014, az: 0.020, fx: 0.39, fy: 0.29, fz: 0.41, px: 2.5,  py: 0.6, pz: 1.0 },
]

class BoneLayer {
  constructor(node) {
    this.node = node
    this.base = { x: 0, y: 0, z: 0 }
    this.written = { x: 0, y: 0, z: 0 }
    this.primed = false
  }

  apply(ox, oy, oz) {
    const r = this.node.rotation
    const fresh = !this.primed
    this.base.x = !fresh && r.x === this.written.x ? this.base.x : r.x
    this.base.y = !fresh && r.y === this.written.y ? this.base.y : r.y
    this.base.z = !fresh && r.z === this.written.z ? this.base.z : r.z
    this.written.x = this.base.x + ox
    this.written.y = this.base.y + oy
    this.written.z = this.base.z + oz
    r.set(this.written.x, this.written.y, this.written.z)
    this.primed = true
  }
}

export class SophiaFace {
  constructor(vrm) {
    this.vrm = vrm
    this.manager = (vrm && vrm.expressionManager) || null

    // Whatever this particular model actually ships.
    const names = new Set()
    const map = this.manager && this.manager.expressionMap
    if (map) {
      for (const key of Object.keys(map)) names.add(key)
    }
    const list = this.manager && this.manager.expressions
    if (Array.isArray(list)) {
      for (const e of list) {
        const n = (e && (e.expressionName || e.name)) || null
        if (n) names.add(n)
      }
    }
    this.available = names

    this.resolved = {}
    for (const logical of Object.keys(CANDIDATES)) {
      this.resolved[logical] = CANDIDATES[logical].find((n) => names.has(n)) || null
    }

    // Smoothed state. `current` chases `target` every frame, so a mood change
    // eases in over ~200ms instead of snapping.
    this.current = {}
    this.target = {}
    for (const logical of Object.keys(CANDIDATES)) {
      this.current[logical] = 0
      this.target[logical] = 0
    }

    this.mood = 'idle'
    this.blinkWeight = 0
    this.blinkPhase = 'wait'
    this.blinkTimer = 1.2
    this.blinkQueued = 0
    this.mouth = 0

    // --- Tunables, all adjustable live from the console. See sophia-avatar.vue.
    // How much of a clip's own head/neck tilt to cancel so she keeps looking at
    // the camera. 0 = leave the animation alone, 1 = force dead level.
    this.GAZE_LEVEL = 0.65
    // Overall size of the continuous talking arm motion. 0 turns it off.
    this.GESTURE_GAIN = 1.0

    // Talking-body state. `talking` is set by the avatar when she starts and stops
    // speaking; `talkBlend` is the eased version actually used, so the motion
    // fades in and out instead of appearing.
    this.talking = false
    this.talkBlend = 0
    this.talkT = 0
    this.armLayers = new Map()
    this.neckLayer = null
    this.visemeT = 0
    // Random phase so two page loads never breathe or drift in lockstep, and so
    // the very first frame is not the peak of every sine at once.
    this.headT = Math.random() * 100
    this.breathT = Math.random() * 100
    // Built lazily on first update: the humanoid may not have these bones, and a
    // null layer is cheaper to check once than three null-guards per frame.
    this.headLayer = null
    this.chestLayer = null
    this.enabled = !!this.manager

    this.setMood('idle')
    this.logSupport(names)
  }

  /** Normalized humanoid bone by VRM name, or null if this rig lacks it. */
  bone(name) {
    const humanoid = this.vrm && this.vrm.humanoid
    if (!humanoid || typeof humanoid.getNormalizedBoneNode !== 'function') return null
    return humanoid.getNormalizedBoneNode(name) || null
  }

  logSupport(names) {
    if (!this.manager) {
      console.warn('[Sophia] This VRM has no expressionManager, so facial expressions and lip-sync are not possible.')
      return
    }
    const total = Object.keys(CANDIDATES).length
    const supported = []
    const missing = []
    for (const logical of Object.keys(this.resolved)) {
      const actual = this.resolved[logical]
      if (actual) supported.push(logical === actual ? logical : logical + '->' + actual)
      else missing.push(logical)
    }
    console.log('[Sophia] Face: ' + supported.length + '/' + total + ' expressions usable: ' + (supported.join(', ') || 'none'))
    if (missing.length) console.log('[Sophia] Face: this model is missing: ' + missing.join(', '))
    console.log('[Sophia] Face: every expression in this model: ' + (Array.from(names).join(', ') || 'none'))
  }

  /** One of the MOOD_BLENDS keys. Unknown moods fall back to a warm resting face. */
  setMood(mood) {
    const blend = MOOD_BLENDS[mood] || MOOD_BLENDS.warm
    this.mood = mood
    for (const logical of Object.keys(this.target)) {
      // Visemes come from audio and blink runs itself; mood must not touch them.
      if (logical === 'blink' || VISEMES.indexOf(logical) !== -1) continue
      this.target[logical] = blend[logical] || 0
    }
  }

  /**
   * Turn the continuous talking-arm motion on or off.
   *
   * Driven from the avatar's speaking state rather than from the mouth level,
   * deliberately. Mouth level drops to zero in the pause between two sentences,
   * and a speaker's hands do not fall to their sides between sentences — they
   * keep moving until the thought is finished.
   */
  setTalking(on) {
    this.talking = !!on
  }

  /** 0..1, from the audio analyser. */
  setMouth(level) {    const n = Number(level)
    this.mouth = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0
  }

  applyWeight(logical, weight) {
    const actual = this.resolved[logical]
    if (!actual) return
    this.manager.setValue(actual, Math.max(0, Math.min(1, weight)))
  }

  updateBlink(delta) {
    if (this.blinkPhase === 'wait') {
      this.blinkTimer -= delta
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 'closing'
        this.blinkTimer = BLINK_CLOSE_S
        if (this.blinkQueued <= 0 && Math.random() < DOUBLE_BLINK_CHANCE) this.blinkQueued = 1
      }
      return
    }
    if (this.blinkPhase === 'closing') {
      this.blinkTimer -= delta
      this.blinkWeight = 1 - Math.max(0, this.blinkTimer) / BLINK_CLOSE_S
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 'held'
        this.blinkTimer = BLINK_HOLD_S
        this.blinkWeight = 1
      }
      return
    }
    if (this.blinkPhase === 'held') {
      this.blinkTimer -= delta
      this.blinkWeight = 1
      if (this.blinkTimer <= 0) {
        this.blinkPhase = 'opening'
        this.blinkTimer = BLINK_OPEN_S
      }
      return
    }
    // opening
    this.blinkTimer -= delta
    this.blinkWeight = Math.max(0, this.blinkTimer) / BLINK_OPEN_S
    if (this.blinkTimer <= 0) {
      this.blinkWeight = 0
      this.blinkPhase = 'wait'
      if (this.blinkQueued > 0) {
        this.blinkQueued -= 1
        this.blinkTimer = 0.16
      } else {
        this.blinkTimer = BLINK_GAP_MIN + Math.random() * (BLINK_GAP_MAX - BLINK_GAP_MIN)
      }
    }
  }

  /**
   * Breath and head drift, layered on top of whatever the mixer just wrote.
   *
   * Both used to be plain `+=` and both integrated without bound — that is the
   * bug BoneLayer above exists to kill. See that comment for why.
   *
   * Amplitudes are deliberately tiny: one to two degrees on the head. Enough to
   * be alive, far too small to read as "turning", which is the thing we do not
   * want. Three incommensurable frequencies mean it never visibly loops.
   */
  updateBody(delta, headNode) {
    const head = headNode || this.bone('head')
    if (head) {
      if (!this.headLayer || this.headLayer.node !== head) this.headLayer = new BoneLayer(head)
      this.headT += delta
      const t = this.headT
      // Refresh the layer's stored base from whatever the mixer just wrote, without
      // adding anything yet. Calling apply twice in one frame is safe by design:
      // the second call sees its own bit pattern in r.x and keeps the same base.
      this.headLayer.apply(0, 0, 0)
      // Gaze leveling. Several of the talk clips were authored with the chin up
      // and the head rolled back, which on screen reads as her talking to someone
      // standing behind the camera rather than to the person in front of her.
      // Cancelling a fraction of the clip's own head pitch pulls her eyeline back
      // to level while leaving the rest of the performance intact. Doing it as a
      // proportion rather than as a fixed angle means a clip that was already
      // level is not dragged downwards.
      const levelPitch = -this.headLayer.base.x * this.GAZE_LEVEL
      const levelRoll = -this.headLayer.base.z * (this.GAZE_LEVEL * 0.5)
      this.headLayer.apply(
        levelPitch + Math.sin(t * 0.53 + 1.7) * 0.013,
        Math.sin(t * 0.37) * 0.020 + Math.sin(t * 0.11) * 0.010,
        levelRoll + Math.sin(t * 0.29 + 0.4) * 0.008,
      )
    }

    // The neck carries most of the lean-back in these clips, so correcting the
    // head alone leaves her looking up from a reclined neck. Same proportional
    // trick, slightly gentler so the two corrections do not compound into a
    // stiff, over-straightened posture.
    const neck = this.bone('neck')
    if (neck) {
      if (!this.neckLayer || this.neckLayer.node !== neck) this.neckLayer = new BoneLayer(neck)
      this.neckLayer.apply(0, 0, 0)
      this.neckLayer.apply(
        -this.neckLayer.base.x * (this.GAZE_LEVEL * 0.7),
        0,
        -this.neckLayer.base.z * (this.GAZE_LEVEL * 0.35),
      )
    }

    // Breathing lives here rather than in the render loop so that every piece of
    // procedural bone motion goes through the same safe mechanism. Chest, falling
    // back to the upper chest and then the spine, because rigs vary.
    const chest = this.bone('chest') || this.bone('upperChest') || this.bone('spine')
    if (chest) {
      if (!this.chestLayer || this.chestLayer.node !== chest) this.chestLayer = new BoneLayer(chest)
      this.breathT += delta
      // ~1.4 degrees of rise and fall at roughly 8-9 breaths a minute.
      this.chestLayer.apply(Math.sin(this.breathT * 0.9) * 0.025, 0, 0)
    }

    this.updateTalkingBody(delta)
  }

  /**
   * Continuous arm and shoulder motion while she speaks.
   *
   * This is the honest answer to "she should be doing things with her hands the
   * whole time she is talking, not standing still". Swapping between talk clips
   * every few seconds gives *variety* but not *continuity* — inside any one clip
   * her arms can sit almost motionless, and that is the dead-looking part.
   *
   * So this layers a small, always-moving offset on top of whichever clip is
   * playing. It is not a gesture and it is not trying to be: it is the low
   * amplitude idling motion a real speaker's hands never stop making. Combined
   * with the clip underneath and the occasional emphasis gesture from the
   * behaviour engine, the result reads as someone talking with their hands.
   *
   * Amplitudes are in radians and deliberately small — the forearms and hands
   * move most, the upper arms less, the shoulders barely at all, which is how
   * human gesture actually distributes. Pushed much past this she starts to look
   * like she is conducting an orchestra.
   *
   * `talkBlend` ramps in and out over about half a second so the motion does not
   * switch on and off abruptly at the start and end of a reply. Every offset goes
   * through BoneLayer, so none of it accumulates.
   */
  updateTalkingBody(delta) {
    const target = this.talking ? 1 : 0
    const rate = delta / TALK_BLEND_S
    this.talkBlend += Math.max(-rate, Math.min(rate, target - this.talkBlend))
    if (this.talkBlend <= 0.001) return

    this.talkT += delta
    const t = this.talkT
    const w = this.talkBlend * this.GESTURE_GAIN

    for (const spec of ARM_SWAY) {
      const node = this.bone(spec.bone)
      if (!node) continue
      let layer = this.armLayers.get(spec.bone)
      if (!layer || layer.node !== node) {
        layer = new BoneLayer(node)
        this.armLayers.set(spec.bone, layer)
      }
      layer.apply(
        Math.sin(t * spec.fx + spec.px) * spec.ax * w,
        Math.sin(t * spec.fy + spec.py) * spec.ay * w,
        Math.sin(t * spec.fz + spec.pz) * spec.az * w,
      )
    }
  }

  /** Call once per frame, after the animation mixer and before vrm.update(). */
  update(delta, headNode) {
    this.updateBody(delta, headNode)
    if (!this.enabled) return
    this.updateBlink(delta)

    // Ease every mood weight toward its target, frame-rate independent.
    const k = 1 - Math.exp(-delta * 9)
    for (const logical of Object.keys(this.current)) {
      this.current[logical] += (this.target[logical] - this.current[logical]) * k
      if (logical === 'blink' || VISEMES.indexOf(logical) !== -1) continue
      this.applyWeight(logical, this.current[logical])
    }

    // Visemes. A single shape opening and closing looks like a puppet, so the
    // amplitude drives `aa` while two slow drifts bleed in `ih`, `ou` and `oh`
    // to keep the shape changing the way a real mouth does between syllables.
    this.visemeT += delta
    const m = this.mouth
    if (m > 0.01) {
      const wobble = Math.sin(this.visemeT * 7.3)
      const wobble2 = Math.sin(this.visemeT * 4.1 + 2.0)
      this.applyWeight('aa', m * (0.72 + 0.22 * wobble))
      this.applyWeight('ih', Math.max(0, m * 0.34 * wobble2))
      this.applyWeight('ou', Math.max(0, m * 0.26 * -wobble))
      this.applyWeight('ee', 0)
      this.applyWeight('oh', Math.max(0, m * 0.18 * -wobble2))
    } else {
      for (const v of VISEMES) this.applyWeight(v, 0)
    }

    // Blink last so nothing overwrites it. Eyes stay a little wider while she
    // is talking, which is what an engaged, animated face does.
    const talkingLift = m > 0.05 ? 0.75 : 1
    this.applyWeight('blink', this.blinkWeight * talkingLift)
  }
}
