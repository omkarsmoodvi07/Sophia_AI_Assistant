import { ref } from 'vue'
import { setMouthLevel } from '@/sophia/mouth'

/**
 * Sophia's voice.
 *
 * The app used to speak through the browser's `speechSynthesis`, which is why
 * she sounded like a screen reader. The backend already ships a real neural TTS
 * service (`internal/audio`, Microsoft Edge Read Aloud â€” free, no API key), it
 * just had no route that handed the audio bytes to a browser. It does now:
 * `POST /api/bots/{botId}/tts/speak` returns playable audio.
 *
 * Design notes that matter for how she *feels*:
 *
 * - The reply is split into sentence-sized chunks and chunk N+1 is synthesized
 *   while chunk N is playing. Time-to-first-word stays under a second even on a
 *   long answer, instead of waiting for the whole paragraph to render.
 * - `isSpeaking` flips on the audio element's real `playing` event and off on
 *   its real `ended` event. Nothing is estimated from text length, so the
 *   talking animation starts and stops exactly when her voice does.
 * - Markdown is stripped before synthesis. Nobody wants to hear "asterisk
 *   asterisk important asterisk asterisk" or a URL read out character by
 *   character.
 * - If the backend TTS is not configured yet, it falls back to the old browser
 *   voice rather than going silent, and says why in the console.
 *
 * Live tuning without a rebuild â€” set these in DevTools and send a message:
 *   localStorage.sophia_tts_voice = 'en-GB-SoniaNeural'   // any Edge voice id
 *   localStorage.sophia_tts_speed = '0.9'                 // 1.0 = normal
 *   localStorage.sophia_tts_pitch = '6'                   // Hz, -100..100
 *   localStorage.sophia_tts_voice = 'off'                 // use model default
 */

export interface SpeakOptions {
  /** Bot UUID. Without it there is no backend voice and we fall back. */
  botId?: string
  voice?: string
  speed?: number
  pitch?: number
  /** Fired once, when the very first audio chunk actually begins playing. */
  onAudioStart?: () => void
}

// A warm, unhurried female voice. Ava is Edge's most natural-sounding English
// multilingual voice; slightly under normal speed and a touch of lift make her
// read like someone talking to you rather than reading at you.
const DEFAULT_VOICE = 'en-IN-NeerjaExpressiveNeural'
const DEFAULT_SPEED = 0.94
const DEFAULT_PITCH = 4

// Hard ceiling on how much of one reply gets spoken.
//
// This was 1600, which is where his long answers were being cut off mid-list â€”
// she would talk through four numbered points and then just stop, which reads as
// her losing interest rather than as a limit being hit. 1600 was chosen to stop
// her monologuing, but that is the wrong problem to solve here: how long she
// talks is the *model's* job, controlled by the personality prompt, not something
// the speech layer should silently override. The speech layer's only legitimate
// job is refusing to read out something pathological, so the number is now high
// enough that a normal long answer always finishes in full.
//
// Chunking means a long reply costs nothing extra up front â€” she starts speaking
// after the first ~320 characters either way, and the rest is synthesized while
// she talks. And `stop()` is called on every new turn, so an over-long answer is
// interrupted the moment the user says anything.
const MAX_TOTAL_CHARS = 12000
// Target chunk size. Small enough that the first chunk returns fast, large
// enough that she does not breathe between every clause.
const CHUNK_CHARS = 320
const HARD_CHUNK_CHARS = 460

const isSpeaking = ref(false)
const engine = ref<'edge' | 'browser' | 'none'>('none')
const lastError = ref('')

let currentAudio: HTMLAudioElement | null = null
// Bumped on every stop()/speak(). Async work from an older generation is
// discarded instead of talking over the new turn.
let generation = 0
// Set once the backend has clearly told us it cannot do this (no TTS model
// configured, route missing). Avoids one failing request per chunk forever.
let backendUnavailable = false

let selectedBrowserVoice: SpeechSynthesisVoice | null = null
let browserVoicesReady = false

function readSetting(key: string): string {
  try {
    return localStorage.getItem(key)?.trim() ?? ''
  } catch {
    return ''
  }
}

function authToken(): string {
  try {
    return localStorage.getItem('token')?.trim() ?? ''
  } catch {
    return ''
  }
}

/** Turn markdown-ish assistant text into something worth listening to. */
export function cleanForSpeech(raw: string): string {
  let s = String(raw ?? '')
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ')
  s = s.replace(/`([^`]*)`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/https?:\/\/\S+/g, ' ')
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*\d+[.)]\s+/gm, '')
  s = s.replace(/^\s*>\s?/gm, '')
  s = s.replace(/(\*\*|__|~~|\*|_)/g, '')
  s = s.replace(/\|/g, ' ')
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0F}]/gu, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  if (s.length > MAX_TOTAL_CHARS) {
    const cut = s.slice(0, MAX_TOTAL_CHARS)
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    s = lastStop > 200 ? cut.slice(0, lastStop + 1) : cut
  }
  return s
}

/** Group whole sentences into chunks so she never breaks mid-thought. */
export function splitIntoChunks(text: string): string[] {
  const sentences = text.match(/[^.!?â€¦]+[.!?â€¦]+["')\]]*\s*|[^.!?â€¦]+$/g) ?? [text]
  const grouped: string[] = []
  let buf = ''
  for (const sentence of sentences) {
    const piece = sentence.trim()
    if (!piece) continue
    if (!buf) {
      buf = piece
    } else if (buf.length + 1 + piece.length <= CHUNK_CHARS) {
      buf += ' ' + piece
    } else {
      grouped.push(buf)
      buf = piece
    }
  }
  if (buf) grouped.push(buf)

  // One runaway sentence with no punctuation still has to be broken up.
  const out: string[] = []
  for (const chunk of grouped) {
    if (chunk.length <= HARD_CHUNK_CHARS) {
      out.push(chunk)
      continue
    }
    for (let i = 0; i < chunk.length; i += HARD_CHUNK_CHARS) {
      out.push(chunk.slice(i, i + HARD_CHUNK_CHARS))
    }
  }
  return out
}

function voiceParams(opts: SpeakOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {}

  const override = readSetting('sophia_tts_voice')
  const voice = opts.voice ?? (override === 'off' ? '' : override || DEFAULT_VOICE)
  if (voice) params.voice = voice

  const speedRaw = readSetting('sophia_tts_speed')
  const speed = opts.speed ?? (speedRaw ? Number(speedRaw) : DEFAULT_SPEED)
  if (Number.isFinite(speed)) params.speed = speed

  const pitchRaw = readSetting('sophia_tts_pitch')
  const pitch = opts.pitch ?? (pitchRaw ? Number(pitchRaw) : DEFAULT_PITCH)
  if (Number.isFinite(pitch)) params.pitch = pitch

  return params
}

/** Returns an object URL for the synthesized chunk, or null if unavailable. */
async function synthesizeChunk(text: string, opts: SpeakOptions): Promise<string | null> {
  const botId = (opts.botId ?? '').trim()
  if (!botId) return null

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = authToken()
  if (token) headers.Authorization = 'Bearer ' + token

  try {
    const response = await fetch('/api/bots/' + encodeURIComponent(botId) + '/tts/speak', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, ...voiceParams(opts) }),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      lastError.value = 'tts ' + response.status + ': ' + detail.slice(0, 300)
      // 400 = no TTS model configured, 404 = server not rebuilt yet. Neither
      // will fix itself on retry, so stop hammering it this session.
      if (response.status === 400 || response.status === 404) {
        backendUnavailable = true
        console.warn(
          '[Sophia] Neural voice disabled for this page. ' + lastError.value + '\n'
          + 'Fix: open /settings/voice, add a "Microsoft Edge" speech provider, then set this bot\'s '
          + 'TTS model in Bot Settings > Multimedia. Then run __sophiaVoice.retryBackend() or reload.',
        )
      }
      return null
    }
    const blob = await response.blob()
    if (!blob.size) {
      lastError.value = 'tts returned an empty audio body'
      return null
    }
    return URL.createObjectURL(blob)
  } catch (error) {
    lastError.value = 'tts request failed: ' + String(error)
    return null
  }
}

// ---------------------------------------------------------------------------
// Lip-sync
//
// Her mouth is driven by the actual waveform, not by a timer and not by
// guessing at phonemes from the text. Measuring the audio that is really
// playing is both simpler and better: pauses, emphasis and breaths all land on
// the frame they happen, because they *are* the signal.
//
// Signal path: <audio> -> MediaElementSource -> AnalyserNode -> speakers.
// Note the analyser is in-line, not a tap. Once an element is routed into a
// WebAudio graph it stops going to the speakers on its own, so if the graph is
// broken she goes silent â€” which is why every failure below is caught and
// degrades to "no lip-sync" rather than "no voice".
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
// Derived from the DOM signature rather than written out as `Uint8Array`.
// TypeScript 5.7 made the typed arrays generic over their backing buffer, so a
// bare `Uint8Array` is `Uint8Array<ArrayBufferLike>` and no longer satisfies
// getByteTimeDomainData's `Uint8Array<ArrayBuffer>`. Taking the type straight
// from the method means this keeps compiling either side of that change.
type TimeDomainBuffer = Parameters<AnalyserNode['getByteTimeDomainData']>[0]
let analyserData: TimeDomainBuffer | null = null
let mouthFrame = 0
// createMediaElementSource() throws if called twice on the same element, and
// there is no way to ask an element whether it has been wrapped, so track it.
const wiredElements = new WeakSet<HTMLMediaElement>()

function ensureAudioGraph(): AnalyserNode | null {
  if (analyser) return analyser
  const Ctor: typeof AudioContext | undefined = window.AudioContext ?? (window as any).webkitAudioContext
  if (!Ctor) return null
  try {
    audioCtx = new Ctor()
    analyser = audioCtx.createAnalyser()
    // 1024 samples is ~21ms at 48kHz: long enough for a stable amplitude, short
    // enough that a consonant still registers before the frame is drawn.
    analyser.fftSize = 1024
    // Explicit ArrayBuffer, not `new Uint8Array(n)`: see TimeDomainBuffer above.
    analyserData = new Uint8Array(new ArrayBuffer(analyser.fftSize))
    analyser.connect(audioCtx.destination)
    return analyser
  } catch (error) {
    console.warn('[Sophia] Lip-sync unavailable, WebAudio would not start:', error)
    analyser = null
    audioCtx = null
    return null
  }
}

/**
 * Get the context awake early. Browsers start every AudioContext suspended
 * until a user gesture, and `speak()` is always reached through one (the user
 * pressed send), so this is the right moment to ask. Doing it here rather than
 * at playback time also means the TTS round-trip covers the resume latency, so
 * even the first chunk of the first reply is analysable.
 */
function primeAudioGraph() {
  const node = ensureAudioGraph()
  if (!node || !audioCtx) return
  if (audioCtx.state === 'suspended') void audioCtx.resume()
}

function wireForLipSync(audio: HTMLAudioElement) {
  const node = ensureAudioGraph()
  if (!node || !audioCtx) return
  if (audioCtx.state !== 'running') {
    // Deliberately bail instead of wiring. Routing an element into a suspended
    // context makes it silent, and createMediaElementSource cannot be undone â€”
    // so the failure mode would be "Sophia has no voice", permanently, for that
    // chunk. Losing lip-sync for one chunk is the far cheaper mistake. Nudge the
    // context so the next chunk works.
    void audioCtx.resume()
    return
  }
  if (wiredElements.has(audio)) return
  try {
    audioCtx.createMediaElementSource(audio).connect(node)
    wiredElements.add(audio)
  } catch (error) {
    console.warn('[Sophia] Could not analyse this audio chunk, mouth will stay closed:', error)
  }
}

function stopMouthTracking() {
  if (mouthFrame) cancelAnimationFrame(mouthFrame)
  mouthFrame = 0
  setMouthLevel(0)
}

function startMouthTracking() {
  if (mouthFrame) return
  let level = 0
  const tick = () => {
    if (!analyser || !analyserData || !currentAudio) {
      mouthFrame = 0
      setMouthLevel(0)
      return
    }
    analyser.getByteTimeDomainData(analyserData)
    let sum = 0
    for (let i = 0; i < analyserData.length; i++) {
      const v = (analyserData[i] ?? 128) / 128 - 1
      sum += v * v
    }
    const rms = Math.sqrt(sum / analyserData.length)
    // Conversational speech sits around 0.03-0.25 RMS. Subtract a small floor so
    // room tone does not hold her mouth ajar, scale into 0..1, then bend the
    // curve: without the exponent, ordinary syllables barely move the jaw while
    // only shouted vowels open it.
    const raw = Math.min(1, Math.max(0, (rms - 0.006) * 6.5)) ** 0.75
    // Asymmetric smoothing. A real jaw opens fast and closes slower, and equal
    // rates make her flutter on every zero-crossing like chattering teeth.
    level += (raw - level) * (raw > level ? 0.55 : 0.22)
    setMouthLevel(level)
    mouthFrame = requestAnimationFrame(tick)
  }
  mouthFrame = requestAnimationFrame(tick)
}

/**
 * Mouth movement for the fallback voice. `speechSynthesis` renders straight to
 * the output device and exposes no node to analyse, so there is genuinely
 * nothing to measure â€” this is an honest approximation rather than a lie about
 * the audio. Two incommensurable rates give an irregular syllable rhythm and the
 * slow term adds phrase-level rise and fall, so it does not look metronomic.
 */
function startFakeMouth() {
  stopMouthTracking()
  let t = 0
  let level = 0
  const tick = () => {
    t += 1 / 60
    const syllable = 0.5 + 0.5 * Math.sin(t * 11.5)
    const phrase = 0.55 + 0.45 * Math.sin(t * 1.7 + 0.9)
    const raw = Math.max(0, syllable * phrase - 0.1)
    level += (raw - level) * (raw > level ? 0.5 : 0.25)
    setMouthLevel(level)
    mouthFrame = requestAnimationFrame(tick)
  }
  mouthFrame = requestAnimationFrame(tick)
}

function playUrl(url: string, gen: number, onStart: () => void): Promise<void> {
  return new Promise((resolve) => {
    const audio = new Audio(url)
    audio.preload = 'auto'
    currentAudio = audio

    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      audio.onplaying = null
      audio.onended = null
      audio.onerror = null
      URL.revokeObjectURL(url)
      if (currentAudio === audio) currentAudio = null
      // Explicit, rather than letting the loop notice currentAudio went null:
      // the next chunk calls startMouthTracking() immediately and its `if
      // (mouthFrame) return` guard would hand off to a loop that is about to
      // cancel itself, leaving nothing driving the mouth for the rest of the reply.
      stopMouthTracking()
      resolve()
    }

    audio.onplaying = () => onStart()
    audio.onended = finish
    audio.onerror = () => {
      lastError.value = 'audio element failed to play the synthesized chunk'
      finish()
    }

    if (gen !== generation) {
      finish()
      return
    }
    wireForLipSync(audio)
    startMouthTracking()
    void audio.play().catch((error) => {
      lastError.value = 'audio play() rejected: ' + String(error)
      console.warn('[Sophia] Voice playback was blocked by the browser:', error)
      finish()
    })
  })
}

function pickBrowserVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? []
  if (!voices.length) return null
  const preferred = ['Google UK English Female', 'Microsoft Aria', 'Microsoft Zira', 'Samantha', 'Victoria', 'Female']
  for (const name of preferred) {
    const match = voices.find(v => v.name.includes(name) && v.lang.startsWith('en'))
    if (match) return match
  }
  return voices.find(v => v.lang.startsWith('en')) ?? voices[0] ?? null
}

function ensureBrowserVoices(): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve()
      return
    }
    if (browserVoicesReady || window.speechSynthesis.getVoices().length) {
      selectedBrowserVoice = pickBrowserVoice()
      browserVoicesReady = true
      resolve()
      return
    }
    window.speechSynthesis.onvoiceschanged = () => {
      selectedBrowserVoice = pickBrowserVoice()
      browserVoicesReady = true
      resolve()
    }
    // Never hang the state machine waiting on a voice list that never arrives.
    window.setTimeout(resolve, 1500)
  })
}

async function browserSpeak(text: string, gen: number, onStart: () => void): Promise<void> {
  if (!window.speechSynthesis) return
  await ensureBrowserVoices()
  if (gen !== generation) return
  window.speechSynthesis.cancel()

  await new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text)
    if (selectedBrowserVoice) utterance.voice = selectedBrowserVoice
    utterance.pitch = 1.12
    utterance.rate = 1.0
    const done = () => {
      stopMouthTracking()
      resolve()
    }
    utterance.onstart = () => {
      startFakeMouth()
      onStart()
    }
    utterance.onend = done
    utterance.onerror = done
    window.speechSynthesis.speak(utterance)
  })
}

function stop() {
  generation += 1
  // A stream parked in waitForMore() would otherwise hold its promise open
  // forever. Its loop re-checks the generation the moment it wakes, so waking it
  // here is what lets it notice it has been superseded and exit.
  const s = stream
  stream = null
  if (s) {
    s.ended = true
    wakeStream(s)
  }
  if (currentAudio) {
    const audio = currentAudio
    currentAudio = null
    audio.onplaying = null
    audio.onended = null
    audio.onerror = null
    try {
      audio.pause()
    } catch {
      // Pausing a never-started element throws in some browsers; harmless.
    }
  }
  try {
    window.speechSynthesis?.cancel()
  } catch {
    // Same.
  }
  stopMouthTracking()
  isSpeaking.value = false
}

async function speak(rawText: string, opts: SpeakOptions = {}): Promise<void> {
  const text = cleanForSpeech(rawText)
  if (!text) return

  stop()
  const gen = generation
  lastError.value = ''
  // We are inside the gesture chain that started with the user pressing send,
  // which is the only time a browser will let WebAudio start. See primeAudioGraph.
  primeAudioGraph()

  let announced = false
  const announce = () => {
    if (announced || gen !== generation) return
    announced = true
    isSpeaking.value = true
    opts.onAudioStart?.()
  }

  const chunks = splitIntoChunks(text)
  // Also the empty-input guard: no first chunk means there is nothing to say,
  // and posting an undefined body would 400 and latch the backend off.
  const firstChunk = chunks[0]
  if (!firstChunk) return
  const canUseBackend = !backendUnavailable && !!(opts.botId ?? '').trim()

  if (canUseBackend) {
    let pending = await synthesizeChunk(firstChunk, opts)
    if (gen !== generation) {
      if (pending) URL.revokeObjectURL(pending)
      return
    }

    if (pending) {
      engine.value = 'edge'
      for (let i = 0; i < chunks.length; i++) {
        if (gen !== generation) {
          if (pending) URL.revokeObjectURL(pending)
          return
        }
        const url = pending
        // Synthesize the next chunk while this one is in the speakers.
        const nextChunk = chunks[i + 1]
        const prefetch = nextChunk
          ? synthesizeChunk(nextChunk, opts)
          : Promise.resolve<string | null>(null)
        if (url) await playUrl(url, gen, announce)
        pending = await prefetch
      }
      if (gen === generation) isSpeaking.value = false
      return
    }

    console.warn('[Sophia] Neural voice unavailable, using the browser voice instead. Reason:', lastError.value)
  }

  engine.value = 'browser'
  await browserSpeak(text, gen, announce)
  if (gen === generation) isSpeaking.value = false
}

// ---------------------------------------------------------------------------
// Streaming speech
//
// `speak()` above is one-shot: it needs the finished reply before it can say a
// word, so she sat silent through the whole generation and only then started
// talking. On a long answer that is several seconds of a woman staring at you
// while text scrolls past, which is the opposite of "someone is talking to me".
//
// The streaming API instead consumes the reply as it arrives:
//
//   beginStream(opts)      once, when the turn starts
//   pushStream(textSoFar)  on every streaming update (cumulative text)
//   endStream(finalText)   once, when generation finishes
//
// Only *completed sentences* are ever queued. A half-finished sentence would be
// synthesized now and then arrive again with its ending attached, so she would
// say the first half twice. The one exception is a run-on with no punctuation at
// all, which is flushed once it passes the hard chunk size so she does not wait
// forever on someone who never types a full stop.
//
// The synthesis pipeline stays one chunk ahead exactly as it does in speak(),
// so the network round-trip for chunk N+1 hides underneath the playback of N.
// ---------------------------------------------------------------------------

interface VoiceStream {
  gen: number
  opts: SpeakOptions
  queue: string[]
  /** How many characters of the cleaned reply have already been queued. */
  spokenLen: number
  /**
   * The exact cleaned prefix already queued. Only used to notice when the text
   * being pushed has stopped being a continuation of it â€” see pushStream.
   */
  spokenText: string
  ended: boolean
  announced: boolean
  wake: (() => void) | null
  done: Promise<void>
}

let stream: VoiceStream | null = null

/**
 * Clean partial text. Identical to cleanForSpeech except that an *unterminated*
 * code fence is dropped: mid-stream the closing ``` has not arrived yet, so the
 * block-stripping regex cannot match and she would read raw source out loud.
 * Cutting at the opening fence is safe because the next push (or endStream)
 * sees the closed block and strips it properly.
 */
function cleanStreamingText(raw: string): string {
  let s = String(raw ?? '')
  const fences = s.match(/```/g)?.length ?? 0
  if (fences % 2 === 1) s = s.slice(0, s.lastIndexOf('```'))
  return cleanForSpeech(s)
}

/** Index just past the last sentence-ending punctuation, or -1 if there is none. */
function lastSentenceEnd(text: string): number {
  const re = /[.!?â€¦]+["')\]]*(?=\s|$)/g
  let idx = -1
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    idx = match.index + (match[0] ?? '').length
  }
  return idx
}

function waitForMore(s: VoiceStream): Promise<void> {
  if (s.queue.length || s.ended) return Promise.resolve()
  return new Promise<void>((resolve) => {
    s.wake = resolve
  })
}

function wakeStream(s: VoiceStream) {
  const resolve = s.wake
  s.wake = null
  resolve?.()
}

async function runStream(s: VoiceStream): Promise<void> {
  const announce = () => {
    if (s.announced || s.gen !== generation) return
    s.announced = true
    isSpeaking.value = true
    s.opts.onAudioStart?.()
  }

  const useBackend = !backendUnavailable && !!(s.opts.botId ?? '').trim()
  let inflight: Promise<string | null> | null = null
  let inflightText = ''

  const startNext = (): boolean => {
    const next = s.queue.shift()
    if (next === undefined) return false
    inflightText = next
    inflight = useBackend ? synthesizeChunk(next, s.opts) : Promise.resolve(null)
    return true
  }

  while (true) {
    if (s.gen !== generation) break
    if (!inflight && !startNext()) {
      // Nothing queued. Either the model is still thinking mid-reply, in which
      // case park until pushStream wakes us, or the reply is over and we are done.
      if (s.ended) break
      await waitForMore(s)
      continue
    }

    const url = await inflight
    const text = inflightText
    inflight = null
    if (s.gen !== generation) {
      if (url) URL.revokeObjectURL(url)
      break
    }

    // Keep the pipeline one ahead before blocking on playback.
    startNext()

    if (url) {
      engine.value = 'edge'
      await playUrl(url, s.gen, announce)
    } else {
      if (useBackend) {
        console.warn('[Sophia] Neural voice unavailable for this chunk, using the browser voice. Reason:', lastError.value)
      }
      engine.value = 'browser'
      await browserSpeak(text, s.gen, announce)
    }
  }

  if (s.gen === generation) {
    isSpeaking.value = false
    if (stream === s) stream = null
  }
}

/** Open a streaming turn. Cancels anything currently being said. */
function beginStream(opts: SpeakOptions = {}): Promise<void> {
  stop()
  lastError.value = ''
  // Inside the user's send gesture, which is the only moment a browser will let
  // an AudioContext start. See primeAudioGraph.
  primeAudioGraph()
  const s: VoiceStream = {
    gen: generation,
    opts,
    queue: [],
    spokenLen: 0,
    spokenText: '',
    ended: false,
    announced: false,
    wake: null,
    done: Promise.resolve(),
  }
  stream = s
  s.done = runStream(s)
  return s.done
}

/**
 * Start counting from zero again when the incoming text is a *new* block rather
 * than more of the current one.
 *
 * A reply that uses tools is not one growing string. She writes a sentence, calls
 * a tool, reads the result, writes more â€” and each of those is a separate
 * assistant message in the transcript, so the "text so far" restarts from empty
 * every time a new block begins. Without this, the `full.length <= s.spokenLen`
 * check treats the shorter new block as stale and drops it: she spoke the first
 * paragraph of a tool-using answer out loud and then went completely silent for
 * the rest of it, while her mouth kept moving to the animation.
 *
 * Compared as a prefix rather than by length, because a new block can easily be
 * longer than the one before it â€” length alone cannot tell continuation from
 * restart. Empty text is ignored: at a segment boundary the transcript's last
 * entry is a tool call, which cleans down to nothing, and rebasing on that would
 * make her repeat the paragraph she had just finished saying.
 */
function rebase(s: VoiceStream, full: string): void {
  if (!full || full.startsWith(s.spokenText)) return
  s.spokenLen = 0
  s.spokenText = ''
}

/** Feed the reply so far. Safe to call on every token; cumulative text expected. */
function pushStream(rawSoFar: string): void {
  const s = stream
  if (!s || s.ended || s.gen !== generation) return

  const full = cleanStreamingText(rawSoFar)
  rebase(s, full)
  if (full.length <= s.spokenLen) return
  const tail = full.slice(s.spokenLen)

  const cut = lastSentenceEnd(tail)
  const ready = cut > 0
    ? tail.slice(0, cut)
    : (tail.length >= HARD_CHUNK_CHARS ? tail : '')
  if (!ready.trim()) return

  for (const chunk of splitIntoChunks(ready)) s.queue.push(chunk)
  s.spokenLen += ready.length
  s.spokenText = full.slice(0, s.spokenLen)
  wakeStream(s)
}

/** Close the turn, flushing whatever sentence fragment is left. */
function endStream(rawFinal?: string): Promise<void> {
  const s = stream
  if (!s || s.gen !== generation) return Promise.resolve()

  if (typeof rawFinal === 'string') {
    const full = cleanStreamingText(rawFinal)
    rebase(s, full)
    const tail = full.slice(s.spokenLen)
    if (tail.trim()) {
      for (const chunk of splitIntoChunks(tail)) s.queue.push(chunk)
      s.spokenLen = full.length
      s.spokenText = full
    }
  }

  s.ended = true
  wakeStream(s)
  return s.done
}

/** Re-arm the neural voice after fixing the TTS config, without a reload. */
function retryBackend() {
  backendUnavailable = false
  lastError.value = ''
  engine.value = 'none'
}

export function useSophiaVoice() {
  // Handy for tuning from DevTools: __sophiaVoice.speak('hello', { botId })
  if (typeof window !== 'undefined') {
    ;(window as any).__sophiaVoice = { speak, stop, beginStream, pushStream, endStream, retryBackend, isSpeaking, engine, lastError }
  }
  return { speak, stop, beginStream, pushStream, endStream, retryBackend, isSpeaking, engine, lastError }
}

