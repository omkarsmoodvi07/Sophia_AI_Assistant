<template>
  <div ref="containerEl" class="fixed inset-0 z-0" :style="{ cursor: dragging ? 'grabbing' : 'grab' }" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp" @wheel="onWheel" @contextmenu.prevent />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as THREE from 'three'
import { VRMLoaderPlugin } from '@pixiv/three-vrm'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { SophiaAnimationController } from '@/sophia/animation-controller.js'
import { SophiaBehaviourEngine } from '@/sophia/sophia-behaviour.js'
import { SophiaFace } from '@/sophia/sophia-face.js'
import { mouth } from '@/sophia/mouth'

const props = withDefaults(defineProps<{
  state?: string
  /** Optional speaking mood: happy | sad | angry | sleepy. Picks the talk pool. */
  emotion?: string
}>(), { state: 'idle', emotion: '' })

const containerEl = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let vrm: any = null
let avatarGroup: THREE.Group | null = null
let animController: SophiaAnimationController | null = null
let behaviour: SophiaBehaviourEngine | null = null
let face: SophiaFace | null = null
let headNode: THREE.Object3D | null = null
let hasInteracted = false
let clock = new THREE.Clock()
let frameId = 0

const dragging = ref(false)
let dragStart = { x: 0, y: 0, mx: 0, my: 0 }

// Storage key is v3 on purpose. v2 held the head-and-shoulders close-up that he
// tried and rejected; leaving the key alone would mean his saved camY/camZ won
// over the new default and the change would look like it never landed. A fresh
// key means everyone gets the new framing exactly once, and their own subsequent
// drags and zooms still persist from there.
const VIEW_KEY = 'sophia_view_v3'
const DEFAULT_VIEW = { x: 0, y: 0, scaleMult: 1, rotY: 0, camY: null as number | null, camZ: null as number | null }
const saved = { ...DEFAULT_VIEW, ...(JSON.parse(localStorage.getItem(VIEW_KEY) || 'null') || {}) }

function persist() {
  localStorage.setItem(VIEW_KEY, JSON.stringify(saved))
}

/**
 * Half-body framing: crown of the head down to about mid-thigh, so both arms are
 * fully in shot.
 *
 * This has now been through both extremes. The original camera at z=2.2 fitted
 * her whole body and left her face about forty pixels tall, so no expression work
 * was visible. Pulling in to head-and-shoulders made every expression readable but
 * cropped her arms off, and gestures are half of what makes her read as present â€”
 * hands that leave the frame are worse than a small face. This is the middle
 * setting, and it is the one he asked for after seeing both.
 *
 * Still derived from the head bone rather than hard-coded, so it reframes
 * correctly if Sophia.vrm is ever swapped for a taller or shorter model. FRAME_H
 * is the world height we want visible and the trig is the inverse of the standard
 * perspective-camera height formula.
 */
// ~1.05m visible. On a 1.6m model that spans roughly y=0.63 to y=1.69: headroom
// above the hair, and the bottom edge below the fingertips of a lowered hand.
const FRAME_H = 1.05
// How far below the head bone the frame centre sits. At 0.24 her face lands in
// the upper third of the shot, which is how a person is normally composed, and
// leaves the lower two thirds for her hands to move in.
const HEAD_DROP = 0.24

function frameOnHead() {
  if (!camera) return
  let headY = 1.4
  const node = vrm?.humanoid?.getNormalizedBoneNode('head')
  if (node) {
    vrm.scene.updateMatrixWorld(true)
    headY = node.getWorldPosition(new THREE.Vector3()).y
  } else if (vrm?.scene) {
    // No head bone: estimate from the bounding box. The skull top is the box
    // top, and a head bone sits roughly 10% of body height below it.
    const box = new THREE.Box3().setFromObject(vrm.scene)
    headY = box.max.y - (box.max.y - box.min.y) * 0.1
  }
  const vFovRad = (camera.fov * Math.PI) / 180
  const dist = FRAME_H / (2 * Math.tan(vFovRad / 2))
  // Camera stays perfectly level â€” no lookAt. A tilted camera on a close-up
  // face reads as a security cam, and it also skews the drag maths.
  camera.position.set(0, saved.camY ?? headY - HEAD_DROP, saved.camZ ?? dist)
}

const ANIMATION_NAMES = [
  'Angry','Angry_Talk','Arm_Stretching','Bboy_Hip_Hop_Move','Blow-Kiss','Blush',
  'Breakdance_Freeze_Var_2','Breathing_Idle','Chicken_Dance','Clapping','Dance-Twirl',
  'Dancing_Maraschino_Step','Dancing_Twerk','Dwarf_Idle','Dwarf_Idle_(1)','Excited',
  'Finger-Gun','Goodbye','Hand-on-hip','Happy_Idle','Happy_Talk','Holding_Head',
  'House_Dancing','Idle','idle_main','Jump','Jumping_Jacks','kneel-wave','LookAround',
  'Loser','Macarena_Dance','Mma_Kick','Mouth_Talking_Test','Mouth_Yawn_Test',
  'Playful_Talk','Pointing_Forward','Praying','quick_formal_bow','Rejected','Relax',
  'Sad','Sad_Talk','Salsa_Dancing','Shouting_Talk','Sleepy','Sleepy_Talk','Smile',
  'Speech_Bright_B','Speech_Calm_A','Speech_Soft_C','Spin','standard_idle',
  'Standing_Greeting','Surprised','Surprised_Reaction','Swing-arms','Swing_Dancing',
  'Talking','Taunt','Thankful','Thinking','Thoughtful_Head_Nod','Twist_Dance',
  'Victory-fingers','VRMA_01','VRMA_02','VRMA_03',
  'VRMA_04','VRMA_05','VRMA_06','VRMA_07',
  'Warrior_Idle','Wink','Yawn','Yelling',
]

onMounted(async () => {
  if (!containerEl.value) return
  const width = window.innerWidth
  const height = window.innerHeight

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20)
  // Placeholder only; frameOnHead() sets the real position once the model's
  // proportions are known. Kept non-zero so a failed load still renders sanely.
  camera.position.set(0, 1.3, 2.2)

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setSize(width, height)
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  containerEl.value.appendChild(renderer.domElement)

  const light = new THREE.DirectionalLight(0xffffff, 1.2)
  light.position.set(1, 1, 1)
  scene.add(light)
  scene.add(new THREE.AmbientLight(0xffffff, 0.6))

  const loader = new GLTFLoader()
  loader.register((parser) => new VRMLoaderPlugin(parser))

  const animLoader = new GLTFLoader()
  animLoader.register((parser) => new VRMAnimationLoaderPlugin(parser))

  const gltf = await loader.loadAsync('/sophia/model/Sophia.vrm')
  vrm = gltf.userData.vrm

  avatarGroup = new THREE.Group()
  avatarGroup.add(vrm.scene)
  scene.add(avatarGroup)
  vrm.scene.rotation.y = Math.PI

  avatarGroup.position.set(saved.x, saved.y, 0)
  avatarGroup.scale.setScalar(saved.scaleMult)
  avatarGroup.rotation.y = saved.rotY || 0
  frameOnHead()

  // Rest-pose fallback: lower arms from VRM's default T-pose immediately, so she
  // never shows T-pose even if the idle animation clip fails to load/apply.
  const humanoid = vrm.humanoid
  if (humanoid) {
    const setRot = (boneName: string, x: number, y: number, z: number) => {
      const node = humanoid.getNormalizedBoneNode(boneName)
      if (node) node.rotation.set(x, y, z)
    }
    setRot('leftUpperArm', 0, 0, -1.4)
    setRot('rightUpperArm', 0, 0, 1.4)
    setRot('leftLowerArm', 0, 0, -0.05)
    setRot('rightLowerArm', 0, 0, 0.05)
  }

  ;(window as any).__sophiaVrm = vrm
  console.log('[Sophia] humanoid bones available:', vrm.humanoid ? Object.keys(vrm.humanoid.humanBones ?? {}) : 'NO HUMANOID')

  // The face is what actually sells her as a person: blinking, brows, and a
  // mouth driven by the real audio. It logs which expressions this model
  // supports on construction, so a missing blendshape shows up in the console
  // instead of just silently doing nothing.
  headNode = vrm.humanoid?.getNormalizedBoneNode('head') ?? null
  face = new SophiaFace(vrm)
  ;(window as any).__sophiaFace = face

  // Make her eyes follow the camera, i.e. follow whoever is looking at her.
  // VRM ships a lookAt rig for exactly this and it was never pointed at
  // anything, so her pupils stayed wherever the clip left them â€” which is a
  // large part of why she read as talking past you rather than to you. The bone
  // corrections in SophiaFace level her head; this aims the eyes inside it.
  if (vrm.lookAt) {
    vrm.lookAt.target = camera
    vrm.lookAt.autoUpdate = true
  }

  // Escape hatches, so a bad framing never needs a rebuild to fix.
  ;(window as any).__sophiaResetView = () => {
    localStorage.removeItem(VIEW_KEY)
    Object.assign(saved, DEFAULT_VIEW)
    avatarGroup?.position.set(0, 0, 0)
    avatarGroup?.scale.setScalar(1)
    if (avatarGroup) avatarGroup.rotation.y = 0
    frameOnHead()
    console.log('[Sophia] View reset to the default half-body framing.')
  }
  ;(window as any).__sophiaFrame = (camY: number, camZ: number) => {
    saved.camY = camY
    saved.camZ = camZ
    persist()
    frameOnHead()
    console.log('[Sophia] Camera set to y=' + camY + ' z=' + camZ)
  }

  animController = new SophiaAnimationController(vrm, animLoader)
  const loaded = await animController.loadAll(ANIMATION_NAMES.map(n => `/sophia/animations/${n}.vrma`))
  console.log('[Sophia] animations actually loaded:', loaded)
  behaviour = new SophiaBehaviourEngine(animController)
  ;(window as any).__sophiaBehaviour = behaviour

  // Where inside Thinking.vrma her held pose is taken from. If she looks like
  // she is mid-reach rather than settled, try 0.35 or 0.7 and watch her while
  // she answers â€” no rebuild needed. See holdPose() in the animation controller.
  ;(window as any).__sophiaThinkAt = (frac: number) => {
    if (!animController) return
    animController.THINK_HOLD_AT = frac
    // Drop the sticky guard so the next thinking call actually re-poses her.
    animController.currentName = null
    console.log('[Sophia] Thinking pose now held at ' + frac + ' of the clip.')
  }

  // How hard to pull her head and neck back to level while she talks. Raise it
  // if she still reads as looking past you, lower it if she looks stiff.
  // 0 leaves the animation clips completely untouched.
  ;(window as any).__sophiaGaze = (amount: number) => {
    if (!face) return
    ;(face as any).GAZE_LEVEL = amount
    console.log('[Sophia] Gaze leveling set to ' + amount + ' (0 = off, 1 = dead level).')
  }

  // Size of the continuous arm motion while she speaks. 1 is the default, 0
  // switches it off entirely, 1.6 or so is noticeably more animated.
  ;(window as any).__sophiaGesture = (gain: number) => {
    if (!face) return
    ;(face as any).GESTURE_GAIN = gain
    console.log('[Sophia] Talking gesture gain set to ' + gain + '.')
  }

  // How often her hands change what they are doing while she talks: the shortest
  // and longest hold in seconds, and the chance each change is a one-shot
  // emphasis gesture rather than a shift to another talk clip.
  // Defaults are 2.6, 5.2, 0.34. Try 1.8, 3.4, 0.45 for a more animated read.
  ;(window as any).__sophiaBeat = (min: number, max: number, chance: number) => {
    if (!behaviour) return
    behaviour.BEAT_MIN_S = min
    behaviour.BEAT_MAX_S = max
    behaviour.EMPHASIS_CHANCE = chance
    // Take effect on the current sentence rather than after the current hold.
    behaviour.beatTimer = 0
    console.log('[Sophia] Gesture beat: ' + min + '-' + max + 's, emphasis chance ' + chance + '.')
  }

  // The state watcher below runs with `immediate: true` at setup time, long
  // before the clips exist, so it no-ops. Apply the current state once here
  // instead of hard-coding a single idle clip â€” otherwise a message sent while
  // the model was still loading would leave her standing still.
  applyState(props.state)

  animate()
  window.addEventListener('resize', onResize)
})

function animate() {
  frameId = requestAnimationFrame(animate)
  const delta = clock.getDelta()

  // ORDER MATTERS, and it used to be wrong. The mixer overwrites bone rotations
  // wholesale every frame, so anything procedural written *before* it was thrown
  // away. Mixer first, then layer on top of its output, then vrm.update() last
  // because that is what pushes the normalized rig into the actual skeleton and
  // applies blendshapes.
  animController?.update(delta)

  // Her gesture clock. While she is talking this shifts her hands every few
  // seconds instead of leaving her in one loop for a whole answer. It is frame
  // driven rather than a setTimeout chain so it cannot outlive the component.
  behaviour?.update(delta)

  // Breathing used to be an extra `chest.rotation.x +=` right here, and that is
  // what was flipping her over backwards mid-answer: `+=` after the mixer
  // integrates on every frame the current clip does not happen to animate the
  // chest. It now lives in SophiaFace.updateBody behind BoneLayer, which tracks
  // the value it wrote last frame and so layers exactly once. Do not add
  // procedural bone motion back into this loop â€” put it in the face controller
  // where the safe mechanism is.
  face?.setMouth(mouth.level)
  face?.update(delta, headNode)

  vrm?.update(delta)
  if (renderer && scene && camera) renderer.render(scene, camera)
}

function onResize() {
  if (!renderer || !camera) return
  const w = window.innerWidth
  const h = window.innerHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
}

// Drag: convert pixel delta to world-space delta at the avatar's depth so
// movement tracks the cursor 1:1 regardless of camera FOV/distance.
function pixelsToWorld(dxPx: number, dyPx: number) {
  if (!camera || !containerEl.value) return { x: 0, y: 0 }
  const h = containerEl.value.clientHeight
  const distance = camera.position.z - (avatarGroup?.position.z ?? 0)
  const vFovRad = (camera.fov * Math.PI) / 180
  const worldHeightAtDist = 2 * Math.tan(vFovRad / 2) * distance
  const unitsPerPixel = worldHeightAtDist / h
  return { x: dxPx * unitsPerPixel, y: -dyPx * unitsPerPixel }
}

let rotating = false
let rotateStartX = 0
let rotateStartY = 0

function onDown(e: PointerEvent) {
  if (!avatarGroup) return
  if (e.button === 2) {
    rotating = true
    rotateStartX = e.clientX
    rotateStartY = avatarGroup.rotation.y
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    return
  }
  dragging.value = true
  dragStart = { x: avatarGroup.position.x, y: avatarGroup.position.y, mx: e.clientX, my: e.clientY }
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
}
function onMove(e: PointerEvent) {
  if (rotating && avatarGroup) {
    avatarGroup.rotation.y = rotateStartY + (e.clientX - rotateStartX) * 0.01
    return
  }
  if (!dragging.value || !avatarGroup) return
  const delta = pixelsToWorld(e.clientX - dragStart.mx, e.clientY - dragStart.my)
  avatarGroup.position.set(dragStart.x + delta.x, dragStart.y + delta.y, avatarGroup.position.z)
}
function onUp() {
  if (dragging.value && avatarGroup) {
    saved.x = avatarGroup.position.x
    saved.y = avatarGroup.position.y
    persist()
  }
  if (rotating && avatarGroup) {
    saved.rotY = avatarGroup.rotation.y
    persist()
  }
  dragging.value = false
  rotating = false
}
function onWheel(e: WheelEvent) {
  if (!avatarGroup) return
  e.preventDefault()
  saved.scaleMult = Math.max(0.3, Math.min(4, saved.scaleMult - e.deltaY * 0.001))
  avatarGroup.scale.setScalar(saved.scaleMult)
  persist()
}

// Which face goes with which talking mood. Nothing here is a grin â€” the
// reference clips stay under about 40% on the smile preset even when she is
// clearly delighted, and going higher turns her into an emoji.
const SPEAKING_MOOD: Record<string, string> = {
  happy: 'happy',
  sad: 'concerned',
  angry: 'angry',
  sleepy: 'idle',
  surprised: 'surprised',
}

function applyState(state: string) {
  if (!behaviour) return

  // Set once, up front, so every branch below agrees. The thinking branch returns
  // early, and an earlier version of this only cleared the flag on the idle path â€”
  // which left her arms swaying while she was supposed to be quietly thinking.
  face?.setTalking(state === 'speaking')

  if (state === 'thinking') {
    // A reaction gesture (wave, bow) may still be mid-clip. It hands off to
    // the thinking loop itself when the mixer says it finished, so cutting in
    // here would just truncate the gesture.
    face?.setMood('thinking')
    if (!behaviour.introBusy) behaviour.thinking()
    return
  }

  if (state === 'speaking') {
    face?.setMood(SPEAKING_MOOD[props.emotion] ?? 'warm')
    behaviour.onAssistantStart(props.emotion || null)
    return
  }


  if (state === 'happy') { face?.setMood('happy'); behaviour.happy(); return }
  if (state === 'concerned') { face?.setMood('concerned'); behaviour.sad(); return }

  // Idle is a single, stable breathing loop and nothing else. There used to be
  // a 15s timer that rolled a random "idle variety" clip (Relax, LookAround,
  // Yawn...) on top of it â€” that is what made her turn left and right by
  // herself right after load. Real stillness reads as calm presence; a body
  // that shuffles poses on a timer reads as a screensaver. Her aliveness while
  // idle comes from the procedural breathing plus blinking and small head
  // motion, all of which run continuously instead of interrupting.
  //
  // The face does change, though: a completely neutral resting face is what
  // makes avatars look switched off. Before the first message she is calm; once
  // they have talked she holds a faint smile, the way someone does when they
  // are still in the conversation with you.
  face?.setMood(hasInteracted ? 'warm' : 'idle')
  behaviour.onAssistantEnd()
}

watch(() => props.state, (state) => applyState(state), { immediate: true })

// The mood can resolve after she has already started talking â€” the first
// sentence may be neutral and the emotional cue arrive in the second. Without
// this, `applyState` would never run again for the rest of the reply and the
// mood would be silently dropped. Guarded to the speaking phase so it cannot
// interrupt a thinking loop or a greeting gesture.
watch(() => props.emotion, () => {
  if (props.state === 'speaking') applyState('speaking')
})

/**
 * Called by the chat pane the instant the user hits send, with what they typed.
 * This is what makes "hi" produce a wave: the behaviour engine reads intent from
 * the text and plays a matching one-shot reaction before settling into thinking.
 */
function onUserMessage(text: string) {
  hasInteracted = true
  behaviour?.onUserMessage(text)
}

defineExpose({ onUserMessage })

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId)
  window.removeEventListener('resize', onResize)
  renderer?.dispose()
})
</script>


