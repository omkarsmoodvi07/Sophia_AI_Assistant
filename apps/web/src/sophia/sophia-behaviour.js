/**
 * Maps Sophia's response states onto animation clips.
 *
 * The one non-obvious rule in here is `introBusy`. When the user says "hi" she
 * should wave, and the wave should finish before anything else takes the body
 * over. But the state machine flips to THINKING in the same tick, and the
 * avatar's state watcher would immediately crossfade the wave away. So a
 * reaction gesture raises `introBusy`, the watcher checks it, and the gesture
 * hands off to the thinking loop itself when the mixer reports it finished.
 *
 * Previously this was attempted with a `pendingIntroGesture` that replayed the
 * wave when the reply started, which meant she waved twice — once on send and
 * once on answer. One wave, at the moment you greet her, reads as human.
 */

// How long she holds one gesture while talking, in seconds. Nobody holds a
// single gesture for a whole paragraph — you make a point, your hands settle,
// then you make the next one.
//
// These came down from 4.0-8.0 once the continuous arm sway in SophiaFace landed.
// At the old spacing her hands only changed twice in a short answer, and between
// those changes the clip itself is nearly static, so she read as standing still
// and lip-syncing. The sway now carries the in-between motion, which means these
// shifts no longer have to do all the work on their own and can be tighter
// without turning into a twitch. Roughly one shift per spoken idea.
const BEAT_MIN_S = 2.6
const BEAT_MAX_S = 5.2
// Chance that a beat is a one-shot emphasis gesture rather than a shift to a
// different talk loop. Raised from 0.22 for the same reason. Still well under a
// half: a pointed finger every few seconds is a lecture, once or twice in an
// answer is emphasis.
const EMPHASIS_CHANCE = 0.34
// One-shots that read as "making a point" rather than as an event. Deliberately
// only two. Most of the gesture pool means something specific — clapping, waving,
// bowing, praying — and firing any of those in the middle of a sentence is
// nonsense, however much it fills the time. A point and a nod are the only two
// clips here that a person actually does while explaining something.
const EMPHASIS_GESTURES = ['Pointing_Forward', 'Thoughtful_Head_Nod']

export class SophiaBehaviourEngine {
  constructor(animationController) {
    this.animation = animationController
    this.state = 'idle'
    this.lastMessage = ''
    this.isSpeaking = false
    // True while a one-shot reaction clip is still playing.
    this.introBusy = false
    // Which talk pool the current reply is using, so a beat stays in character.
    this.emotion = null
    // Counts down while she speaks; each expiry moves her hands. See update().
    this.beatTimer = 0
    // Copied onto the instance so they can be dialled live from the console
    // (__sophiaBeat) without a rebuild. How animated she looks is a matter of
    // taste, and taste is much easier to settle by watching than by guessing.
    this.BEAT_MIN_S = BEAT_MIN_S
    this.BEAT_MAX_S = BEAT_MAX_S
    this.EMPHASIS_CHANCE = EMPHASIS_CHANCE
  }

  setState(state) { this.state = state }

  rollBeat() {
    this.beatTimer = this.BEAT_MIN_S + Math.random() * (this.BEAT_MAX_S - this.BEAT_MIN_S)
  }

  /**
   * Frame tick, driven from the avatar's render loop.
   *
   * This is what he meant by wanting her to move her hands while explaining
   * instead of standing in one loop doing nothing but lip-sync. Every few seconds
   * of speech she either shifts to a different talk clip or throws in a one-shot
   * emphasis gesture and returns to talking. Because everything crossfades over
   * FADE_SPEAKING it reads as her shifting posture mid-thought rather than as an
   * animation change.
   *
   * Worth being clear about what this does and does not do. Her face, blinking,
   * breathing and lip-sync already run every frame completely independently of
   * whatever the body is doing, so those genuinely are simultaneous. The *body*
   * still plays one clip at a time, because the .vrma files are absolute poses
   * rather than deltas — blending two of them additively fights over the same
   * bones instead of combining. Rotating between clips on a beat is the honest
   * way to get variety out of that; true simultaneous layering would mean
   * splitting clips per bone group, which is a much larger change.
   */
  update(delta) {
    if (!this.isSpeaking || this.introBusy) return
    this.beatTimer -= delta
    if (this.beatTimer > 0) return
    this.rollBeat()

    if (Math.random() < this.EMPHASIS_CHANCE) {
      const gesture = this.animation.randomFrom(EMPHASIS_GESTURES)
      if (gesture) {
        // introBusy parks the beat clock as well as the state watcher, so a beat
        // cannot land on top of the gesture it just started.
        this.introBusy = true
        this.animation.playOnceThen(gesture, () => {
          this.introBusy = false
          // She may have finished talking while the gesture played; onAssistantEnd
          // has already moved her to idle, so do not drag her back to a talk loop.
          if (this.isSpeaking) this.animation.playSpeakingEmotion(this.emotion)
        })
        return
      }
    }

    this.animation.playNextSpeaking(this.emotion)
  }

  /** Play a one-shot reaction, then fall into the thinking loop on its own. */
  reactThen(name) {
    if (!name || !this.animation.animations.has(name)) { this.thinking(); return }
    this.introBusy = true
    this.animation.playOnceThen(name, () => {
      this.introBusy = false
      // If her voice already started while the gesture played, she is talking
      // now — do not yank her back into thinking.
      if (this.state !== 'speaking') this.thinking()
    })
  }

  /**
   * Called the moment the user sends. Reads intent from the message so the
   * first thing she does is a reaction to what was said, not a generic pause.
   */
  onUserMessage(text) {
    const lower = String(text ?? '').toLowerCase().trim()
    this.lastMessage = lower
    this.state = 'thinking'
    this.introBusy = false

    if (!lower) { this.thinking(); return }

    if (/\bdance\b/.test(lower)) {
      this.reactThen(this.animation.randomFrom(this.animation.danceAnimations))
      return
    }
    if (/^(hi+|hey+|yo|hello+|heya|howdy)\b/.test(lower)
      || /\b(hello|hey there|good morning|good afternoon|good evening)\b/.test(lower)) {
      this.reactThen('Standing_Greeting')
      return
    }
    if (/\bthank/.test(lower)) {
      this.reactThen('Thankful')
      return
    }
    if (/\b(bye|goodbye|good night|goodnight|see you|see ya)\b/.test(lower)) {
      this.reactThen('Goodbye')
      return
    }
    if (/\b(wow|whoa|amazing|incredible|no way|unbelievable)\b/.test(lower)) {
      this.reactThen(this.animation.randomFrom(this.animation.surprisedEmotionAnimations))
      return
    }
    if (/\b(congrats|congratulations|awesome|great news|yay|i did it|i passed)\b/.test(lower)) {
      this.reactThen(this.animation.randomFrom(this.animation.happyEmotionAnimations))
      return
    }
    if (/\b(sad|depressed|upset|lonely|exhausted)\b/.test(lower)) {
      this.reactThen(this.animation.randomFrom(this.animation.sadEmotionAnimations))
      return
    }
    this.thinking()
  }

  /** Called when her voice actually starts. */
  onAssistantStart(emotion) {
    this.isSpeaking = true
    this.state = 'speaking'
    this.introBusy = false
    this.emotion = emotion || null
    // Full beat before the first shift, so she settles into talking rather than
    // changing pose the instant she opens her mouth.
    this.rollBeat()
    this.animation.playSpeakingEmotion(this.emotion)
  }

  onAssistantEnd() {
    this.isSpeaking = false
    this.emotion = null
    this.beatTimer = 0
    this.state = 'idle'
    this.animation.playIdle()
  }

  thinking() { this.state = 'thinking'; this.animation.playThinking() }
  gesture(name) { this.animation.playGesture(name) }
  idle() { this.state = 'idle'; this.animation.playIdle() }
  idleVariety() { this.animation.playIdleVariety() }
  speaking() { this.state = 'speaking'; this.animation.playSpeaking() }
  surprise() { this.state = 'surprised'; this.animation.playSurprisedEmotion() }
  happy() { this.state = 'happy'; this.animation.playHappyEmotion() }
  sad() { this.state = 'sad'; this.animation.playSadEmotion() }
  angry() { this.state = 'angry'; this.animation.playAngryEmotion() }
}
