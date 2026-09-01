import { computed, ref, watch } from 'vue'
import { useSophiaVoice } from '@/composables/useSophiaVoice'

/**
 * Sophia's response state machine.
 *
 * The old code derived the avatar state from a `computed()` over `messages[]`:
 * streaming with an empty message array meant "thinking", streaming with any
 * content meant "speaking". That is why the thinking animation flickered. Two
 * reasons, both structural rather than a tuning problem:
 *
 *  1. `messages[]` mutates many times per reply, so the computed re-evaluated
 *     constantly and the animation controller kept picking a *new* random clip
 *     from the thinking pool.
 *  2. On a rate-limited model the runtime retries, which makes `streaming` go
 *     true -> false -> true within a second or two. Every flip reset the state.
 *
 * So this is a latch instead of a derivation. THINKING is entered once, when
 * the user sends, and it is only left on a terminal event: her voice actually
 * starting (-> SPEAKING), her voice finishing (-> IDLE), or a reply that has
 * nothing worth saying out loud (-> IDLE). Nothing in between can disturb it,
 * which is exactly the "stay until the thinking is over" behaviour we want.
 *
 * SPEAKING is driven by real audio events from `useSophiaVoice`, not by a
 * character-count estimate, so her mouth stops when her voice stops.
 */

export type SophiaAvatarState = 'idle' | 'thinking' | 'speaking' | 'happy' | 'concerned'

export interface SophiaStageOptions {
  /** Bot UUID, used for the TTS request. */
  botId: () => string
  /** True while the runtime is producing a reply. */
  streaming: () => boolean
  /** Webcam-detected mood, used only when she is otherwise idle. */
  webcamEmotion: () => string
  /** The finished assistant reply, read once streaming ends. */
  replyText: () => string
}

// Never read API plumbing out loud. Rate limits and stack traces are for the
// transcript, not for her voice.
const NOT_SPEAKABLE = /api error|quota|rate.?limit|resource_exhausted|failed:|exceeded|too many requests|\b429\b|\b5\d\d\b\s*(error|status)/i

// If a reply never lands (dropped socket, aborted run) she should return to
// idle rather than think forever.
const THINKING_TIMEOUT_MS = 120_000

// How long the words have to stay finished before we believe the turn is over.
//
// `streaming` is not one clean true-then-false for a reply that uses tools. Every
// tool call ends a runtime segment and the next one opens a new one, so inside a
// single answer it goes true, false, true, false, true... Standing her down on the
// first false is what produced the flicker: she dropped into the resting idle loop
// and then re-entered thinking between every step, which showed up in the console
// as Speech_Calm_A -> Breathing_Idle -> Thinking -> Speech_Calm_A -> ... over and
// over inside one reply.
//
// A short settle window swallows those gaps. A new segment arriving inside the
// window cancels the stand-down completely; only a gap longer than this counts as
// the end of the answer. Long enough to cover the round trip of a tool call and
// its approval round trip, short enough that the pause after she genuinely stops
// talking does not read as her standing there frozen.
const SETTLE_MS = 1600

// ---------------------------------------------------------------------------
// Mood
//
// The avatar has always accepted an `emotion` prop that picks her talking
// animation pool and her face (see SPEAKING_MOOD in sophia-avatar.vue), and
// nothing was ever bound to it â€” so every reply, however warm or however sad,
// was delivered from the neutral pool with the same faint smile.
//
// This is a text heuristic, deliberately, and it is worth being clear that it is
// the cheaper of two options. The better one is for the model to label its own
// reply, which is what the emotion engine in the reference app does; that needs
// a tag stripped out of the transcript before render, and getting that wrong
// means `[[mood:happy]]` showing up on screen. The heuristic cannot leak into
// the UI at all, so it ships first and the model-labelled version replaces it
// once the streaming path has settled.
//
// Only the opening of the reply is scanned. Emotional register is set in the
// first sentence or two, and matching against a long answer's full text means
// every reply eventually contains some cue and the face becomes noise.
// ---------------------------------------------------------------------------

const MOOD_SCAN_CHARS = 600

// Deliberately excludes apology and reassurance formulas ("I'm so sorry", "I'm
// here"): she says those constantly while being helpful, and reading them as
// sadness made her play Sad_Talk through cheerful, ordinary replies. Keep only
// cues that are actually about the person having a hard time.
const SAD_HINTS = /\b(that sounds (hard|tough|painful|exhausting|lonely|awful)|must be (hard|tough|difficult|exhausting|lonely)|take your time|be (gentle|kind) with yourself|that'?s a lot|you'?re not alone|carrying a lot|overwhelmed|struggling|worried about you|grief|heartbreaking)\b/i

const HAPPY_HINTS = /\b(congratulations|congrats|well done|proud of you|that'?s (great|wonderful|excellent|brilliant|amazing|fantastic)|great news|nailed it|you did it|so glad|really glad|happy for you|delighted|love (this|that|it)|perfect|brilliant)\b/i

function detectMood(text: string): string {
  const opening = String(text ?? '').slice(0, MOOD_SCAN_CHARS)
  const sad = SAD_HINTS.test(opening)
  const happy = HAPPY_HINTS.test(opening)
  // A reply that reads as both ("I'm sorry, but well done for trying") is
  // ambiguous, and neutral-warm is the safe read of an ambiguous sentence.
  if (sad === happy) return ''
  return sad ? 'sad' : 'happy'
}

// Module-level (not per-mount) so a reply already spoken is never re-read
// after any remount of the component that calls useSophiaStage — regardless
// of what caused the remount (reconnect, route change, etc).
let __lastSpokenReplyGlobal = ''

export function useSophiaStage(opts: SophiaStageOptions) {
  const { beginStream, pushStream, endStream, stop: stopVoice, isSpeaking, engine, lastError } = useSophiaVoice()

  const phase = ref<'idle' | 'thinking' | 'speaking'>('idle')
  /** Drives the avatar's `emotion` prop: '' | 'happy' | 'sad'. */
  const mood = ref('')
  let thinkingTimer: number | undefined
  let settleTimer: number | undefined
  // Set when her voice pipeline finishes. See maybeGoIdle: her body stops
  // talking only when the words have stopped arriving AND the voice is done.
  let voiceDone = false
  // Set once we are confident the *text* is finished, which is not the same thing
  // as `streaming` having gone false even once. See scheduleSettle.
  let settled = false
  // Incremented per user turn. Async work tagged with an older turn is ignored,
  // so a fast second message never gets narrated over by the first one.
  let turn = 0
  // The full reply text of the last answer we actually spoke aloud. The runtime
  // can re-assert an active run status after a turn has already settled â€” a
  // trailing projection update, a reconnect, a heartbeat â€” with no new user
  // message and no new text. Without this guard each such re-assert was treated
  // as a fresh turn: it opened a new voice stream and the settle timer re-flushed
  // the entire reply into it, so she read the same answer aloud over and over
  // until you typed something. We compare against this to tell a genuinely new
  // reply apart from the same finished reply flapping back to active.

  function clearThinkingTimer() {
    if (thinkingTimer !== undefined) {
      window.clearTimeout(thinkingTimer)
      thinkingTimer = undefined
    }
  }

  function clearSettleTimer() {
    if (settleTimer !== undefined) {
      window.clearTimeout(settleTimer)
      settleTimer = undefined
    }
  }

  /**
   * Re-armed on every segment, not just at the start of the turn.
   *
   * A reply that runs six tools with an approval prompt in the middle can easily
   * outlive a two minute window while making perfectly good progress. Armed once
   * at send, this timeout would have shrugged and dropped her to idle in the
   * middle of a working answer.
   */
  function armThinkingTimeout() {
    clearThinkingTimer()
    thinkingTimer = window.setTimeout(() => {
      if (phase.value === 'thinking') goIdle()
    }, THINKING_TIMEOUT_MS)
  }

  function goIdle() {
    clearThinkingTimer()
    clearSettleTimer()
    phase.value = 'idle'
  }

  /**
   * Stand down only if the whole reply is genuinely over.
   *
   * All three conditions matter and getting any of them wrong is visible. If she
   * idles when the voice finishes, a short or silent utterance drops her hands
   * while text is still printing â€” she stops talking mid-answer. If she idles when
   * the text finishes, she keeps speaking with her arms at her sides, because the
   * audio always lags the last token. And if she idles the first time `streaming`
   * goes false, she resets between every tool call. So: the words have to have
   * settled, the voice has to have drained, and nothing new can be arriving.
   */
  function maybeGoIdle() {
    if (!settled) return
    if (!voiceDone) return
    if (opts.streaming()) return
    goIdle()
  }

  /**
   * The words have stopped. Wait to find out whether that was the end of the
   * answer or just the gap before her next tool call.
   */
  function scheduleSettle() {
    clearSettleTimer()
    const myTurn = turn
    settleTimer = window.setTimeout(() => {
      settleTimer = undefined
      if (turn !== myTurn || opts.streaming()) return
      settled = true
      clearThinkingTimer()
      const reply = opts.replyText()
      // The final block of a tool-using answer is often a short factual sign-off
      // with no emotional cue in it, so an empty read here must not wipe the mood
      // that was detected from the substance of the reply.
      mood.value = detectMood(reply) || mood.value
      // Flush the trailing fragment and let the voice drain. Closing the stream
      // here rather than at the first `streaming === false` is the whole point:
      // endStream is final, so calling it between two tool calls would leave the
      // rest of the answer with nowhere to be spoken.
      // Remember exactly what we spoke, so a later run-status re-assert carrying
      // this same finished text does not restart the turn and read it a second time.
      __lastSpokenReplyGlobal = reply
      void endStream(reply)
      maybeGoIdle()
    }, SETTLE_MS)
  }

  /** Call the moment the user sends. Latches THINKING for the whole turn. */
  function beginTurn() {
    turn += 1
    const myTurn = turn
    clearThinkingTimer()
    clearSettleTimer()
    phase.value = 'thinking'
    mood.value = ''
    voiceDone = false
    settled = false

    // Opening the stream here, rather than when the first token arrives, is
    // deliberate: beginStream primes the AudioContext, and we are still inside
    // the click that sent the message â€” the only moment a browser will allow it.
    // An open stream with an empty queue costs nothing; it parks until there is
    // a finished sentence to say.
    void beginStream({
      botId: opts.botId(),
      // Kept as a safety net for turns whose text never routes through
      // replyText (a resumed run, another device). The normal path switches to
      // SPEAKING on the first printed character instead â€” see the replyText
      // watcher â€” because that is what the eye is actually comparing her against.
      onAudioStart: () => {
        if (turn === myTurn && phase.value === 'thinking') phase.value = 'speaking'
      },
    }).finally(() => {
      if (turn !== myTurn) return
      voiceDone = true
      maybeGoIdle()
    })

    armThinkingTimeout()
  }

  // Feed the reply to her voice as it arrives. This is what makes her start
  // talking while the text is still printing instead of after it finishes.
  // pushStream only ever queues completed sentences, so she does not stutter
  // over a half-arrived clause.
  watch(opts.replyText, (text) => {
    if (phase.value === 'idle') return
    const reply = String(text ?? '')
    if (!reply.trim()) return
    if (NOT_SPEAKABLE.test(reply)) {
      // An error is landing in the transcript. Say nothing and stand down â€”
      // checked on every update rather than once at the end, because with
      // streaming we would otherwise have already read half of it aloud.
      stopVoice()
      goIdle()
      return
    }
    // Her body starts talking on the first printed character.
    //
    // This used to wait for onAudioStart, and that is what made the mismatch he
    // could see: TTS has to be requested, synthesized and returned before the
    // first sample plays, so text was already scrolling down the pane while she
    // stood there in the thinking pose. The eye compares her against the words on
    // screen, not against the loudspeaker, so the words are what she has to match.
    if (phase.value === 'thinking') phase.value = 'speaking'
    // Words are still arriving, so whatever gap triggered a pending stand-down
    // was a tool call and not the end of the answer.
    if (!settled) clearSettleTimer()
    // Sticky: a later paragraph that happens to carry no emotional cue must not
    // wipe the mood set by the one that did.
    mood.value = detectMood(reply) || mood.value
    pushStream(reply)
  })

  watch(opts.streaming, (streaming, wasStreaming) => {
    if (streaming) {
      // A genuinely new turn. Either she was idle â€” a reply that was not started
      // from this composer, such as a resumed run, a scheduled task, or a message
      // sent from another device â€” or the previous turn already settled and closed
      // its voice stream, so there is nothing left to continue into.
      if (phase.value === 'idle' || settled) {
        // Guard against the runtime re-asserting an active run status after the
        // turn has already settled â€” a trailing projection update, a reconnect, a
        // heartbeat â€” with no new user message and no new text. That used to be
        // taken as a fresh turn: beginTurn opened a new voice stream and the
        // settle timer re-flushed the whole finished reply into it, so she spoke
        // the same answer again and again until you typed something. If the
        // current reply is byte-for-byte what we last spoke aloud, nothing new has
        // been said â€” stay put instead of starting another turn.
        if (String(opts.replyText() ?? '') === __lastSpokenReplyGlobal) return
        beginTurn()
        return
      }
      // Same turn, next step: she has called a tool and is waiting on the result.
      // Cancel the pending stand-down and put her back in the held thinking pose
      // rather than letting her fall into the resting idle loop and climb back out
      // of it. Left alone if her voice is still draining the previous sentence,
      // because yanking her body out of talking while she is still audibly talking
      // is exactly the mismatch we spent the last two rounds removing.
      clearSettleTimer()
      armThinkingTimeout()
      if (!isSpeaking.value) phase.value = 'thinking'
      return
    }
    if (!wasStreaming) return

    const reply = opts.replyText()
    if (NOT_SPEAKABLE.test(reply)) {
      stopVoice()
      goIdle()
      return
    }

    // Deliberately no `!reply.trim()` stand-down here any more. At a segment
    // boundary the last entry in the transcript is a tool call rather than her
    // text, so the reply reads as empty even though she is mid-answer â€” treating
    // that as "nothing to say" ended the turn on her first tool call. An answer
    // that really is empty still ends, one settle window later.
    scheduleSettle()
  })

  const avatarState = computed<SophiaAvatarState>(() => {
    if (phase.value === 'speaking' || isSpeaking.value) return 'speaking'
    if (phase.value === 'thinking') return 'thinking'
    switch (opts.webcamEmotion()) {
      case 'happy':
        return 'happy'
      case 'sad':
      case 'angry':
      case 'fearful':
      case 'disgusted':
        return 'concerned'
      default:
        return 'idle'
    }
  })

  return { avatarState, mood, phase, beginTurn, goIdle, stopVoice, isSpeaking, engine, lastError }
}


