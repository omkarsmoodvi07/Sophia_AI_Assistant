import { ref, onBeforeUnmount } from "vue"
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision"

export type DetectedEmotion = "happy" | "sad" | "angry" | "surprised" | "fearful" | "disgusted" | "neutral"

let debugEl: HTMLDivElement | null = null
function debugLog(msg: string) {
  if (!debugEl) {
    debugEl = document.createElement("div")
    debugEl.style.cssText = "position:fixed;top:60px;left:8px;z-index:9999;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;padding:6px 10px;border-radius:6px;max-width:340px;white-space:pre-wrap;"
    document.body.appendChild(debugEl)
  }
  debugEl.textContent = msg
}

function score(map: Map<string, number>, ...keys: string[]): number {
  return keys.reduce((sum, k) => sum + (map.get(k) ?? 0), 0) / keys.length
}

function classify(map: Map<string, number>): { emotion: DetectedEmotion; score: number; all: Record<string, number> } {
  const happy = score(map, "mouthSmileLeft", "mouthSmileRight") + 0.4 * score(map, "cheekSquintLeft", "cheekSquintRight")
  const sad = score(map, "mouthFrownLeft", "mouthFrownRight") + 0.6 * score(map, "browInnerUp")
  const angry = score(map, "browDownLeft", "browDownRight") + 0.4 * score(map, "mouthPressLeft", "mouthPressRight")
  const surprised = 0.6 * score(map, "browOuterUpLeft", "browOuterUpRight") + score(map, "eyeWideLeft", "eyeWideRight") + 0.5 * score(map, "jawOpen")
  const fearful = score(map, "eyeWideLeft", "eyeWideRight") + score(map, "browInnerUp") + 0.4 * score(map, "mouthStretchLeft", "mouthStretchRight")
  const disgusted = score(map, "noseSneerLeft", "noseSneerRight") + score(map, "mouthUpperUpLeft", "mouthUpperUpRight")

  const scores: [DetectedEmotion, number][] = [
    ["happy", happy], ["sad", sad], ["angry", angry],
    ["surprised", surprised], ["fearful", fearful], ["disgusted", disgusted],
  ]
  scores.sort((a, b) => b[1] - a[1])
  const [topEmotion, topScore] = scores[0]
  const all = Object.fromEntries(scores.map(([k, v]) => [k, Number(v.toFixed(2))]))
  if (topScore < 0.35) return { emotion: "neutral", score: topScore, all }
  return { emotion: topEmotion, score: topScore, all }
}

export function useWebcamEmotion() {
  const emotion = ref<DetectedEmotion>("neutral")
  const active = ref(false)
  let stream: MediaStream | null = null
  const history: DetectedEmotion[] = []
  const HISTORY_SIZE = 5
  const MIN_AGREEMENT = 3
  function stabilize(raw: DetectedEmotion): DetectedEmotion {
    history.push(raw)
    if (history.length > HISTORY_SIZE) history.shift()
    const counts = new Map<DetectedEmotion, number>()
    for (const e of history) counts.set(e, (counts.get(e) ?? 0) + 1)
    let best: DetectedEmotion = emotion.value
    let bestCount = 0
    for (const [e, c] of counts) { if (c > bestCount) { best = e; bestCount = c } }
    return bestCount >= MIN_AGREEMENT ? best : emotion.value
  }
  let videoEl: HTMLVideoElement | null = null
  let loopHandle: number | null = null
  let landmarker: FaceLandmarker | null = null

  async function loadModel() {
    if (landmarker) return
    debugLog("loading MediaPipe...")
    const vision = await FilesetResolver.forVisionTasks("/mediapipe-wasm")
    try {
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: "GPU" },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      })
    } catch {
      landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate: "CPU" },
        outputFaceBlendshapes: true,
        runningMode: "VIDEO",
        numFaces: 1,
      })
    }
    debugLog("model loaded")
  }

  async function start() {
    try {
      await loadModel()
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
      videoEl = document.createElement("video")
      videoEl.srcObject = stream
      videoEl.muted = true
      await videoEl.play()
      active.value = true
      debugLog("camera started")
      loop()
    } catch (e) {
      debugLog("START FAILED: " + String(e))
      throw e
    }
  }

  function loop() {
    if (!active.value || !videoEl || !landmarker) return
    try {
      const result = landmarker.detectForVideo(videoEl, performance.now())
      const shapes = result.faceBlendshapes?.[0]?.categories
      if (shapes && shapes.length) {
        const map = new Map(shapes.map((c) => [c.categoryName, c.score]))
        const { emotion: detected, score: s, all } = classify(map)
        emotion.value = stabilize(detected)
        debugLog(`emotion: ${detected} (${s.toFixed(2)})\n` + JSON.stringify(all))
      } else {
        debugLog("no face detected")
      }
    } catch (e) {
      debugLog("LOOP ERROR: " + String(e))
    }
    loopHandle = window.setTimeout(loop, 300)
  }

  function stop() {
    active.value = false
    if (loopHandle) clearTimeout(loopHandle)
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    if (debugEl) { debugEl.remove(); debugEl = null }
  }

  onBeforeUnmount(stop)

  return { emotion, active, start, stop }
}