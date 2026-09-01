import * as THREE from 'three'
import { createVRMAnimationClip } from '@pixiv/three-vrm-animation'

export class SophiaAnimationController {
  constructor(vrm, gltfLoader) {
    this.vrm = vrm
    this.loader = gltfLoader
    this.mixer = new THREE.AnimationMixer(vrm.scene)
    this.animations = new Map()
    this.currentAction = null
    this.currentName = null

    // Order here is PRIORITY, not a random pool. She must always settle into the
    // same breathing idle, otherwise a re-roll between 'Breathing_Idle', 'Idle'
    // and 'idle_main' makes her look like she is turning left and right on her
    // own. The 2nd and 3rd entries are only fallbacks if the first failed to load.
    this.idleAnimations = ['Breathing_Idle', 'Idle', 'idle_main']
    this.idleVarietyAnimations = [
      'Relax', 'Sleepy', 'LookAround', 'Wink', 'Hand-on-hip', 'Arm_Stretching',
      'Blush', 'Yawn', 'Mouth_Yawn_Test', 'Dwarf_Idle', 'Dwarf_Idle_(1)', 'Warrior_Idle',
    ]
    // 'Holding_Head' used to be in here and read as a headache, and 'LookAround'
    // turned her whole body away mid-thought. A person thinking looks at you.
    this.thinkingAnimations = ['Thinking', 'Thoughtful_Head_Nod']
    this.speakingNeutralAnimations = ['Talking', 'Mouth_Talking_Test', 'Speech_Calm_A', 'Speech_Bright_B', 'Speech_Soft_C']
    this.speakingHappyAnimations = ['Happy_Talk', 'Playful_Talk']
    this.speakingSadAnimations = ['Sad_Talk']
    this.speakingAngryAnimations = ['Angry_Talk', 'Shouting_Talk', 'Yelling']
    this.speakingSleepyAnimations = ['Sleepy_Talk']
    this.happyEmotionAnimations = ['Happy_Idle', 'Smile', 'Excited', 'Wink', 'Blush', 'Victory-fingers', 'Finger-Gun']
    this.sadEmotionAnimations = ['Sad', 'Rejected', 'Loser', 'Holding_Head']
    this.angryEmotionAnimations = ['Angry', 'Taunt']
    this.surprisedEmotionAnimations = ['Surprised', 'Surprised_Reaction']
    this.gestureAnimations = [
      'Standing_Greeting', 'quick_formal_bow', 'Blow-Kiss', 'Clapping', 'Finger-Gun',
      'Goodbye', 'kneel-wave', 'Pointing_Forward', 'Praying', 'Thankful', 'Victory-fingers',
    ]
    this.danceAnimations = [
      'Bboy_Hip_Hop_Move', 'Breakdance_Freeze_Var_2', 'Chicken_Dance', 'Dance-Twirl',
      'Dancing_Maraschino_Step', 'Dancing_Twerk', 'House_Dancing', 'Macarena_Dance',
      'Salsa_Dancing', 'Swing_Dancing', 'Twist_Dance', 'Spin', 'Jump', 'Jumping_Jacks',
      'Swing-arms', 'Mma_Kick',
    ]

    // Where inside the thinking clip to freeze. See holdPose(). 0 is the first
    // frame, 1 the last. Tunable at runtime via window.__sophiaThinkAt(n) so a
    // bad-looking pose does not need a rebuild to correct.
    this.THINK_HOLD_AT = 0.55

    // Default crossfade lengths. Longer = smoother, no hard snap between poses.
    this.FADE_IDLE = 0.9
    this.FADE_THINKING = 0.7
    this.FADE_SPEAKING = 0.6
    this.FADE_GESTURE = 0.5
    this.FADE_EMOTION = 0.6
  }

  async load(name, url) {
    try {
      const gltf = await this.loader.loadAsync(url)
      const vrmAnimations = gltf.userData.vrmAnimations
      if (!vrmAnimations || vrmAnimations.length === 0) throw new Error(`No VRM animations found in ${name}`)
      const clip = createVRMAnimationClip(vrmAnimations[0], this.vrm)
      if (!clip) throw new Error(`Could not create animation clip for ${name}`)
      this.animations.set(name, clip)
      console.log(`[Sophia] Animation loaded: ${name}`)
      return clip
    } catch (error) {
      console.error(`[Sophia] Failed loading ${name}:`, error)
      throw error
    }
  }

  async loadAll(animationFiles) {
    const results = []
    for (const file of animationFiles) {
      const decodedPath = decodeURIComponent(file)
      const name = decodedPath.split('/').pop().replace(/\.vrma$/i, '')
      try {
        await this.load(name, file)
        results.push(name)
      } catch (error) {
        console.error(`[Sophia] Could not load ${name}:`, error)
      }
    }
    console.log(`[Sophia] Animations loaded: ${results.length}/${animationFiles.length}`)
    return results
  }

  // Returns the THREE.AnimationAction that was started, or null.
  play(name, options = {}) {
    const clip = this.animations.get(name)
    if (!clip) { console.warn(`[Sophia] Animation not found: ${name}`); return null }
    const { loop = true, fade = 0.6, clampWhenFinished = false } = options
    const nextAction = this.mixer.clipAction(clip)
    if (this.currentAction === nextAction) return nextAction
    nextAction.reset()
    nextAction.enabled = true
    if (loop) {
      nextAction.setLoop(THREE.LoopRepeat, Infinity)
    } else {
      nextAction.setLoop(THREE.LoopOnce, 1)
      nextAction.clampWhenFinished = clampWhenFinished
    }
    if (this.currentAction) this.currentAction.fadeOut(fade)
    nextAction.fadeIn(fade)
    nextAction.play()
    this.currentAction = nextAction
    this.currentName = name
    console.log(`[Sophia] Playing: ${name}`)
    return nextAction
  }

  // Plays a one-shot clip, then calls onDone() once it finishes (via the
  // mixer's real 'finished' event, not a guessed timer) — this is what makes
  // "wave, then start talking" land at the actual end of the wave, not early
  // or late.
  playOnceThen(name, onDone, fade = 0.5) {
    const action = this.play(name, { loop: false, fade, clampWhenFinished: true })
    if (!action) { onDone(); return }
    const handler = (e) => {
      if (e.action !== action) return
      this.mixer.removeEventListener('finished', handler)
      onDone()
    }
    this.mixer.addEventListener('finished', handler)
  }

  stop(fade = 0.6) {
    if (this.currentAction) {
      this.currentAction.fadeOut(fade)
      this.currentAction = null
      this.currentName = null
    }
  }

  randomFrom(list) {
    const available = list.filter((name) => this.animations.has(name))
    if (!available.length) return null
    return available[Math.floor(Math.random() * available.length)]
  }

  // Highest-priority clip in the list that actually loaded. Used for the states
  // that must look the same every single time (idle, thinking).
  firstAvailable(list) {
    for (const name of list) {
      if (this.animations.has(name)) return name
    }
    return null
  }

  // Deterministic sibling of playFromPool: same stickiness, no dice roll. If the
  // clip on screen already belongs to this list, keep it; otherwise play the
  // highest-priority one. This is what stops her drifting between poses.
  playPrimary(list, options) {
    if (this.currentName && list.includes(this.currentName) && this.currentAction?.isRunning()) {
      return this.currentAction
    }
    const name = this.firstAvailable(list)
    if (!name) return null
    return this.play(name, options)
  }

  // Pool players below all go through this. The stickiness matters: if the
  // clip already on screen belongs to the pool being requested, keep playing
  // it. Without this, any repeated call to playThinking() re-rolls the dice and
  // crossfades to a different thinking clip, which is what made the thinking
  // animation look like it was flickering between poses.
  playFromPool(list, options) {
    if (this.currentName && list.includes(this.currentName) && this.currentAction?.isRunning()) {
      return this.currentAction
    }
    const name = this.randomFrom(list)
    if (!name) return null
    return this.play(name, options)
  }

  // The deliberate opposite of playFromPool. That one is sticky so repeated
  // calls for the same state do not re-roll the dice; this one insists on a
  // *change*, and prefers a clip other than the one already playing. It is what
  // lets her shift gesture partway through a long answer instead of holding a
  // single talk loop for the whole thing.
  playNextFromPool(list, options) {
    const available = list.filter((name) => this.animations.has(name))
    if (!available.length) return null
    const others = available.filter((name) => name !== this.currentName)
    // A one-clip pool (Sad_Talk is the only sad talk clip we have) falls back to
    // itself, and play() then no-ops because the action is already current. So a
    // small pool degrades to "no change" rather than to a visible re-trigger.
    const pool = others.length ? others : available
    const pick = pool[Math.floor(Math.random() * pool.length)]
    return this.play(pick, options)
  }

  /** The talk-loop pool for an emotion, defaulting to neutral. */
  speakingPool(emotion) {
    const pools = {
      happy: this.speakingHappyAnimations,
      sad: this.speakingSadAnimations,
      angry: this.speakingAngryAnimations,
      sleepy: this.speakingSleepyAnimations,
    }
    return pools[emotion] ?? this.speakingNeutralAnimations
  }

  /**
   * Move smoothly into one pose from a clip and then STAY there.
   *
   * This exists because of a real complaint about the thinking loop: she would
   * adopt the thinking pose, return to neutral, adopt it again, return again,
   * on about a two second cycle, for as long as the answer took. It was not a
   * flicker between clips and it was not a tuning problem — Thinking.vrma is a
   * complete gesture that starts at rest, moves to the pose and comes back to
   * rest. Played on LoopRepeat, that round trip is the loop, so "waiting" looked
   * like a nervous tic.
   *
   * What a person actually does while thinking is reach the pose and hold it. So
   * we start the clip, jump to the point where the pose has been reached, and
   * pause the action there. Pausing sets the action's timeScale to zero, which
   * freezes the clip time but leaves the mixer's weight interpolation running —
   * so the fadeIn still happens and she eases into the held pose over `fade`
   * rather than snapping to it.
   *
   * She does not look frozen while held, because none of what makes her look
   * alive comes from this clip: breathing, blinking, brow and small head motion
   * are all layered on top of the mixer output every frame by SophiaFace.
   *
   * Guarded on currentName rather than on isRunning(), deliberately. A paused
   * action reports isRunning() === false, so an isRunning() check would treat the
   * held pose as finished and restart the clip on the next call — which would
   * reintroduce the exact repeat this method removes.
   */
  holdPose(list, { fade = 0.6, at = 0.55 } = {}) {
    const name = this.firstAvailable(list)
    if (!name) return null
    if (this.currentName === name) return this.currentAction
    const action = this.play(name, { loop: true, fade })
    if (!action) return null
    const duration = action.getClip()?.duration ?? 0
    const frac = Math.max(0, Math.min(1, at))
    action.time = duration * frac
    action.paused = true
    return action
  }

  playIdle() {
    return this.playPrimary(this.idleAnimations, { loop: true, fade: this.FADE_IDLE })
  }

  playIdleVariety() {
    const a = this.randomFrom(this.idleVarietyAnimations)
    if (a) this.play(a, { loop: false, fade: this.FADE_IDLE, clampWhenFinished: false })
  }

  // Held, not looped. She reaches the thinking pose and stays in it for as long
  // as the answer takes, which is what "stay in the thinking position until the
  // thinking is over" actually requires. See holdPose() for why looping this clip
  // made her cycle in and out of the pose every couple of seconds.
  playThinking() {
    return this.holdPose(this.thinkingAnimations, { fade: this.FADE_THINKING, at: this.THINK_HOLD_AT })
  }

  playSpeaking() {
    return this.playFromPool(this.speakingNeutralAnimations, { loop: true, fade: this.FADE_SPEAKING })
  }

  playSpeakingEmotion(emotion) {
    return this.playFromPool(this.speakingPool(emotion), { loop: true, fade: this.FADE_SPEAKING })
  }

  /** Shift to a different talk loop within the same emotion. See playNextFromPool. */
  playNextSpeaking(emotion) {
    return this.playNextFromPool(this.speakingPool(emotion), { loop: true, fade: this.FADE_SPEAKING })
  }

  playHappyEmotion() {
    return this.playFromPool(this.happyEmotionAnimations, { loop: true, fade: this.FADE_EMOTION })
  }

  playSadEmotion() {
    return this.playFromPool(this.sadEmotionAnimations, { loop: true, fade: this.FADE_EMOTION })
  }

  playAngryEmotion() {
    return this.playFromPool(this.angryEmotionAnimations, { loop: true, fade: this.FADE_EMOTION })
  }

  playSurprisedEmotion() {
    const a = this.randomFrom(this.surprisedEmotionAnimations)
    if (a) this.play(a, { loop: false, fade: this.FADE_EMOTION })
  }

  playGesture(name) {
    return this.play(name, { loop: false, fade: this.FADE_GESTURE, clampWhenFinished: false })
  }

  playRandomGesture() {
    const a = this.randomFrom(this.gestureAnimations)
    if (a) this.playGesture(a)
  }

  playRandomDance() {
    const a = this.randomFrom(this.danceAnimations)
    if (a) this.play(a, { loop: false, fade: this.FADE_GESTURE })
  }

  update(delta) {
    this.mixer.update(delta)
  }
}