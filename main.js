import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ------------------------------------------------------------------ *
 * Scene / renderer
 * ------------------------------------------------------------------ */

const F0 = 1, F1 = 1150;                 // Blender timeline (24 fps)

/* The walk-through uses the 28 mm lens set on the Blender camera. On a 16:9
 * frame that is a 65.2° horizontal field of view; we hold the HORIZONTAL fov
 * constant and derive the vertical from the window, so the framing tracks the
 * Blender viewport whatever shape the browser is. */
const HFOV = 65.2 * Math.PI / 180;

/* only used before scene.glb finishes loading */
const CAM_HOME_POS = new THREE.Vector3(-26, 1.6, 7.5);
const CAM_HOME_TGT = new THREE.Vector3(-19, 1.7, 7.5);

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
scene.fog = new THREE.Fog(0x0b0f14, 55, 220);

const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);

/* lights — the GLB exports no lights, so we light it ourselves */
const hemi = new THREE.HemisphereLight(0x9fc2ff, 0x2f2a22, 0.7);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d8, 2.4);
sun.position.set(24, 34, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 140;
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42;
sun.shadow.camera.bottom = -42;
sun.shadow.bias = -0.0008;
scene.add(sun);

/* ground disc */
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(90, 64),
  new THREE.MeshStandardMaterial({ color: 0x1c2a20, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

/* ------------------------------------------------------------------ *
 * Scroll → frame mapping
 *
 * Each <section> declares data-f0 / data-f1: the Blender frame at its
 * top edge and at its bottom edge. Scrolling through that section
 * interpolates between those two frames, so the captions stay in sync
 * with the walk instead of drifting.
 * ------------------------------------------------------------------ */

const sections = [...document.querySelectorAll('.panel')].map(el => ({
  el, f0: +el.dataset.f0, f1: +el.dataset.f1, top: 0, h: 1
}));

function measure() {
  for (const s of sections) {
    s.top = s.el.offsetTop;
    s.h = Math.max(s.el.offsetHeight, 1);
  }
}
measure();

function frameAtScroll(scrollY) {
  const probe = scrollY + window.innerHeight * 0.5;
  if (sections.length === 0) return F0;
  if (probe <= sections[0].top) return sections[0].f0;
  const last = sections[sections.length - 1];
  // the centre-probe can never reach the document's bottom edge, so clamp
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  if (scrollY >= maxScroll - 4) return last.f1;
  if (probe >= last.top + last.h) return last.f1;
  for (const s of sections) {
    if (probe >= s.top && probe < s.top + s.h) {
      const t = (probe - s.top) / s.h;
      return s.f0 + (s.f1 - s.f0) * t;
    }
  }
  return last.f1;
}

/* ------------------------------------------------------------------ *
 * Load the GLB and read the build metadata Blender wrote into extras.
 *
 * All extras live in glTF / Y-up space already (Blender (x,y,z) → (x,z,-y)).
 *
 *   bs_kind : "loc" | "scale" | "rot" | "pos"
 *   bs_win  : [frameStart, frameEnd]
 *   bs_off  : start offset for "loc";  end = static - off
 *   bs_rot  : flat [frame, value, ...] angle about glTF Y
 *   bs_pos  : flat [frame, x, y, z, ...] for the camera + its aim target
 *   bs_hide : frame before which the node (and its subtree) is not shown
 * ------------------------------------------------------------------ */

const parts = [];
const walkers = [];              // pedestrians: driven by wall clock, not scroll
let ready = false;
let camNode = null, camTgt = null;

function extra(node, key) {
  const u = node.userData;
  if (!u) return undefined;
  if (u[key] !== undefined) return u[key];
  // GLTFLoader has grouped extras differently across versions
  for (const k in u) {
    const v = u[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && v[key] !== undefined) {
      return v[key];
    }
  }
  return undefined;
}

const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

function rotAt(keys, f) {
  const n = keys.length / 2;
  if (f <= keys[0]) return keys[1];
  for (let i = 0; i < n - 1; i++) {
    const f0 = keys[i * 2], v0 = keys[i * 2 + 1];
    const f1 = keys[i * 2 + 2], v1 = keys[i * 2 + 3];
    if (f <= f1) {
      const span = f1 - f0 || 1;
      return v0 + (v1 - v0) * smooth((f - f0) / span);
    }
  }
  return keys[keys.length - 1];
}

function posAt(keys, f, out) {
  const n = keys.length / 4;
  if (f <= keys[0]) return out.set(keys[1], keys[2], keys[3]);
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = a + 4;
    if (f <= keys[b]) {
      const t = smooth((f - keys[a]) / ((keys[b] - keys[a]) || 1));
      return out.set(
        keys[a + 1] + (keys[b + 1] - keys[a + 1]) * t,
        keys[a + 2] + (keys[b + 2] - keys[a + 2]) * t,
        keys[a + 3] + (keys[b + 3] - keys[a + 3]) * t
      );
    }
  }
  const l = keys.length - 4;
  return out.set(keys[l + 1], keys[l + 2], keys[l + 3]);
}

function applyFrame(f) {
  for (const p of parts) {
    if (p.hideAt !== null) {
      const vis = f >= p.hideAt;
      if (p.node.visible !== vis) p.node.visible = vis;
    }
    if (!p.kind) continue;

    if (p.kind === 'pos') {
      posAt(p.keys, f, p.node.position);
      continue;
    }
    const t = smooth((f - p.f0) / ((p.f1 - p.f0) || 1));
    if (p.kind === 'loc') {
      p.node.position.lerpVectors(p.startPos, p.endPos, t);
    } else if (p.kind === 'scale') {
      p.node.scale.lerpVectors(p.startScale, p.endScale, t);
    } else {
      _q.setFromAxisAngle(Y_AXIS, rotAt(p.keys, f));
      p.node.quaternion.copy(p.baseQuat).multiply(_q);
    }
  }
}

const loader = new GLTFLoader();
loader.load(
  'scene.glb',
  gltf => {
    const root = gltf.scene;
    const pedRoots = [];
    root.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      if (o.name.startsWith('Ped_') && o.name.endsWith('_Root')) pedRoots.push(o);
      if (o.isCamera && !camNode) camNode = o;
      if (o.name === 'Cam_Walk') camNode = o;
      if (o.name === 'Cam_WalkTarget') camTgt = o;

      const kind = extra(o, 'bs_kind');
      const hide = extra(o, 'bs_hide');
      if (!kind && hide === undefined) return;
      const win = extra(o, 'bs_win') || [0, 0];

      const p = {
        node: o,
        kind: kind || null,
        f0: +win[0],
        f1: +win[1],
        hideAt: hide === undefined ? null : +hide,
        baseScale: o.scale.clone(),
        baseQuat: o.quaternion.clone()
      };

      if (kind === 'loc') {
        // The glTF exporter bakes each node's STATIC transform as the animation's
        // *first* key value, not its final pose. So: start = static, end = start - off.
        const off = extra(o, 'bs_off') || [0, 0, 0];
        p.startPos = o.position.clone();
        p.endPos = o.position.clone().sub(new THREE.Vector3(+off[0], +off[1], +off[2]));
      } else if (kind === 'rot') {
        p.keys = extra(o, 'bs_rot');
        if (!p.keys) return;
      } else if (kind === 'scale') {
        // static scale is the grow start (0.001); everything grows to full size
        p.startScale = o.scale.clone();
        p.endScale = new THREE.Vector3(1, 1, 1);
      } else if (kind === 'pos') {
        p.keys = extra(o, 'bs_pos');
        if (!p.keys) return;
      }
      parts.push(p);
    });

    /* Pedestrians walk on wall-clock time, not on the scrollbar. Only their
     * root carries bs_* (bs_hide — the frame at which they may appear); the
     * limbs carry none, so applyFrame() never fights these writes. Each paces
     * its own stretch of pavement (ped_path) and turns around at the ends. */
    pedRoots.forEach((rt, i) => {
      const id = rt.name.slice(0, 7);                       // "Ped_01_"
      const g = s => rt.getObjectByName(id + s);
      const path = extra(rt, 'ped_path') || [-14.5, 10];
      walkers.push({
        root: rt,
        body: g('Body'), legL: g('LegL'), legR: g('LegR'),
        armL: g('ArmL'), armR: g('ArmR'),
        x0: +path[0], x1: +path[1],
        x: rt.position.x, baseY: rt.position.y,
        speed: +extra(rt, 'ped_speed') || 1.05,
        dir: +extra(rt, 'ped_dir0') < 0 ? -1 : 1,
        yaw: rt.rotation.y,
        phase: (i * 2.399) % (Math.PI * 2)                 // stagger the strides
      });
    });

    scene.add(root);
    ready = parts.length > 0;
    applyFrame(F0);
    document.getElementById('loader').classList.add('done');
    if (!ready) {
      document.getElementById('hud-phase').textContent =
        'no build metadata found in scene.glb';
    }
  },
  undefined,
  err => {
    console.error(err);
    document.getElementById('loader').textContent =
      'could not load scene.glb — serve this folder over HTTP';
  }
);

/* ------------------------------------------------------------------ *
 * Pedestrians — real time, independent of the scroll position.
 *
 * The rig is built facing +X in Blender, so in glTF (Y-up) a forward step
 * swings a limb about its local +Z: legL.z = +a sends the left foot east.
 * Turning the body about the up axis (Y) by PI reverses the whole rig, so
 * the same signs stay "forward" whichever way the walker faces.
 *
 * While pivoting at a path end translation stops but the stride keeps
 * cycling (walking on the spot) — no moon-walking through the turn.
 * ------------------------------------------------------------------ */

const STRIDE = 1.35;                 // metres per full (two-step) cycle

function updateWalkers(dt) {
  for (const w of walkers) {
    const want = w.dir > 0 ? 0 : Math.PI;
    let d = want - w.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const turning = Math.abs(d) > 0.12;
    const walk = turning ? 0 : w.speed;              // stop while pivoting
    const cadence = turning ? w.speed * 0.45 : w.speed;

    w.x += w.dir * walk * dt;
    if (w.x >= w.x1) { w.x = w.x1; w.dir = -1; }
    else if (w.x <= w.x0) { w.x = w.x0; w.dir = 1; }
    w.yaw += d * Math.min(1, dt * 7);
    w.phase += dt * cadence * (Math.PI * 2) / STRIDE;

    const s = Math.sin(w.phase);
    w.root.position.x = w.x;
    w.root.position.y = w.baseY + 0.02 * (0.5 - 0.5 * Math.cos(2 * w.phase));
    w.root.rotation.y = w.yaw;
    if (w.legL) {
      w.legL.rotation.z = 0.52 * s;
      w.legR.rotation.z = -0.52 * s;
      w.armL.rotation.z = -0.34 * s;                 // arms counter-swing
      w.armR.rotation.z = 0.34 * s;
    }
    if (w.body) {
      w.body.rotation.x = 0.035 * s;                 // lateral sway
      w.body.rotation.z = -0.05;                     // slight forward lean
    }
  }
}

/* ------------------------------------------------------------------ *
 * Scroll + render loop
 * ------------------------------------------------------------------ */

let scrollTarget = 0;
let scrollSmooth = 0;
let frameCur = F0;
let lastT = performance.now();

function onScroll() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  scrollTarget = max > 0 ? window.scrollY / max : 0;
}
window.addEventListener('scroll', onScroll, { passive: true });

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const vfov = 2 * Math.atan(Math.tan(HFOV / 2) / camera.aspect);
  camera.fov = Math.min(85, Math.max(18, vfov * 180 / Math.PI));
  camera.updateProjectionMatrix();
  measure();
  onScroll();
}
window.addEventListener('resize', resize);
resize();
onScroll();

const hudFrame = document.getElementById('hud-frame');
const hudPhase = document.getElementById('hud-phase');

function phaseOf(f) {
  if (f < 10) return 'at the gate';
  if (f < 55) return 'the gate opens';
  if (f < 140) return 'the road appears';
  if (f < 207) return 'house across the street';
  if (f < 297) return 'the first house';
  if (f < 378) return 'fence and pines';
  if (f < 537) return 'the second house';
  if (f < 700) return 'walking east';
  if (f < 790) return 'the roundabout';
  if (f < 910) return 'the waterfall';
  if (f < 1070) return 'the mosque';
  return 'the whole society';
}

function tick() {
  requestAnimationFrame(tick);

  const nowT = performance.now();
  const dt = Math.min(0.05, Math.max(0, (nowT - lastT) / 1000));   // clamp: no jump after tab-out
  lastT = nowT;

  scrollSmooth += (scrollTarget - scrollSmooth) * 0.09;
  const frameTarget = frameAtScroll(
    scrollSmooth * (document.documentElement.scrollHeight - window.innerHeight));
  frameCur += (frameTarget - frameCur) * 0.16;

  if (ready) { applyFrame(frameCur); updateWalkers(dt); }

  /* the walk itself: position + aim both come out of the exported camera rig */
  if (ready && camNode && camTgt) {
    camera.position.copy(camNode.position);
    camera.lookAt(camTgt.position);
  } else {
    camera.position.copy(CAM_HOME_POS);
    camera.lookAt(CAM_HOME_TGT);
  }

  renderer.render(scene, camera);

  hudFrame.textContent = 'frame ' + Math.round(frameCur);
  hudPhase.textContent = phaseOf(frameCur);
}
tick();
