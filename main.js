import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ------------------------------------------------------------------ *
 * Scene / renderer
 * ------------------------------------------------------------------ */

const F0 = 1, F1 = 1450;                 // Blender timeline (24 fps)

/* The walk-through uses the 20 mm lens set on the Blender camera (widened
 * from 28 mm — it read as zoomed-in and the gate's base fell below the
 * frame while the aim held the sign). On a 16:9 frame that is an 83.97°
 * horizontal field of view; we hold the HORIZONTAL fov constant and derive
 * the vertical from the window, so the framing tracks the Blender viewport
 * whatever shape the browser is. */
const HFOV = 83.974 * Math.PI / 180;

/* Reduced motion: the walk itself stays (it is scroll-driven, so the user
 * drives it), but wall-clock animation - pedestrians striding, the guard's
 * idle scan - holds still. CSS mirrors this for the caption reveal. */
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* only used before scene.glb finishes loading — mirrors the f1 camera aim */
const CAM_HOME_POS = new THREE.Vector3(-26, 1.6, 7.5);
const CAM_HOME_TGT = new THREE.Vector3(-17, 2.8, 7.5);

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

/* ------------------------------------------------------------------ *
 * Sky + grassy ground.
 *
 * Deliberately built on the website side: glTF cannot carry Blender's
 * world shader (a skybox would never survive the export), and the
 * ground disc has always been a main.js object rather than part of
 * scene.glb. Painting both here keeps the validated GLB untouched.
 * ------------------------------------------------------------------ */

const SKY_HORIZON = '#e6eef2';       // fog must match this or the horizon shows a seam

/* deterministic RNG so sky and scatter are identical on every load */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Equirectangular day sky: vertical gradient, high cirrus streaks and
 * soft cumulus clusters in a band above the horizon. Every cloud blob is
 * drawn three times (x-w, x, x+w) so clusters wrap seamlessly across the
 * texture's u seam. */
function makeSky() {
  const tex = canvasTexture(2048, 1024, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.00, '#2f6fb5');            // zenith: ACES desaturates
    grad.addColorStop(0.26, '#4a8ccd');            // blues, so paint them
    grad.addColorStop(0.42, '#6fa9da');            // richer than the target.
    grad.addColorStop(0.475, '#9cc6e6');           // The walk looks level or
    grad.addColorStop(0.495, '#d3e6f0');           // down, so blue has to
    grad.addColorStop(0.50, SKY_HORIZON);          // reach almost the horizon:
    grad.addColorStop(0.53, '#dfeae4');            // ground fog does the
    grad.addColorStop(0.78, '#cbdacb');            // atmospheric blend.
    grad.addColorStop(1.00, '#b7c8bb');            // nadir, hidden under the ground
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);

    const rnd = mulberry32(20260924);
    const blob = (x, y, r, col, a) => {
      for (const off of [-w, 0, w]) {
        const rg = g.createRadialGradient(x + off, y, 0, x + off, y, r);
        rg.addColorStop(0, `rgba(${col},${a})`);
        rg.addColorStop(1, `rgba(${col},0)`);
        g.fillStyle = rg;
        g.beginPath();
        g.arc(x + off, y, r, 0, Math.PI * 2);
        g.fill();
      }
    };

    /* cirrus: thin, high, faint (kept low: eye level only sees v 0.35..0.5) */
    for (let i = 0; i < 10; i++) {
      const cx = rnd() * w;
      const cy = h * (0.315 + rnd() * 0.06);
      const len = 140 + rnd() * 320;
      const th = 6 + rnd() * 10;
      const a = 0.09 + rnd() * 0.09;
      for (const off of [-w, 0, w]) {
        g.fillStyle = `rgba(255,255,255,${a})`;
        g.beginPath();
        g.ellipse(cx + off, cy, len, th, 0, 0, Math.PI * 2);
        g.fill();
      }
    }

    /* cumulus: white puffs, then grey bellies tucked underneath. The band
     * sits v 0.32..0.475, just above the horizon, where the eye-level walk
     * actually looks; opacity is high because ACES + haze eat low alphas. */
    for (let i = 0; i < 24; i++) {
      const cx = rnd() * w;
      const cy = h * (0.32 + rnd() * 0.155);
      const spread = 110 + rnd() * 170;
      const puffs = 7 + Math.floor(rnd() * 8);
      for (let p = 0; p < puffs; p++) {
        blob(cx + (rnd() - 0.5) * spread * 1.6,
             cy + (rnd() - 0.5) * spread * 0.55,
             24 + rnd() * spread * 0.6, '255,255,255', 0.24 + rnd() * 0.26);
      }
      for (let p = 0; p < puffs; p++) {
        blob(cx + (rnd() - 0.5) * spread * 1.5,
             cy + spread * 0.30 + (rnd() - 0.5) * spread * 0.34,
             30 + rnd() * spread * 0.5, '150,166,188', 0.14 + rnd() * 0.10);
      }
    }

    /* fine grain: a smooth 8-bit gradient otherwise shows faint crosshatch
       banding once ACES has stretched it in the browser */
    for (let i = 0; i < 90000; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.05)';
      g.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
  });
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = makeSky();
scene.fog = new THREE.Fog(SKY_HORIZON, 60, 240);

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

/* soft fill from the west so faces turned away from the sun (the gate's
 * approach side, the booths, the guard) are not swallowed by shadow */
const fill = new THREE.DirectionalLight(0xcfe0ff, 1.3);
fill.position.set(-36, 12, 18);
scene.add(fill);

/* ------------------------------------------------------------------ *
 * Ground + scattered greenery (glTF / Y-up space).
 * The disc gets a tiled canvas grass speckle, then two InstancedMeshes
 * lay down the small stuff: tiny crossed-quad grass tufts and low bush
 * clumps. Slots are rejected over the road corridor, the roundabout
 * and the house/mosque yards so nothing ever grows through the model.
 * ------------------------------------------------------------------ */

const grassTex = canvasTexture(512, 512, (g, w, h) => {
  g.fillStyle = '#57743d';
  g.fillRect(0, 0, w, h);
  const rnd = mulberry32(4711);
  /* soft patches of shade and sun so the tiling never reads as flat */
  for (let i = 0; i < 30; i++) {
    const x = rnd() * w, y = rnd() * h, r = 40 + rnd() * 120;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, rnd() > 0.5 ? 'rgba(126,152,79,.10)' : 'rgba(58,82,42,.12)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  /* blade speckle: thousands of 1-3 px nicks in four greens */
  const tones = ['#466130', '#698a4a', '#7b9650', '#8f9a52'];
  for (let i = 0; i < 14000; i++) {
    g.fillStyle = tones[(rnd() * tones.length) | 0];
    const bw = 1 + ((rnd() * 2.6) | 0);
    g.fillRect(rnd() * w, rnd() * h, bw, bw + ((rnd() * 2) | 0));
  }
});
grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
grassTex.repeat.set(36, 36);
grassTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(90, 64),
  new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
ground.receiveShadow = true;
scene.add(ground);

/* exclusion zones in glTF space: road + both sidewalks (z 4..11) with the
 * east extension past the roundabout, roundabout island at (16, 7.5),
 * the three house yards, the mosque, wall legs, new buildings */
function soilIsFree(x, z) {
  if (x > -28 && x < 41 && z > 3.6 && z < 11.4) return false;   // road corridor, incl. east extension
  if (Math.hypot(x - 16, z - 7.5) < 6.1) return false;            // roundabout
  if (x > -8.5 && x < 1.5 && z > -4 && z < 3.4) return false;     // house 1 yard
  if (x > 2 && x < 8 && z > -4 && z < 3.4) return false;          // house 2 yard
  if (x > -3.5 && x < 3.5 && z > 11.5 && z < 18) return false;    // house 3 yard
  if (x > 11.5 && x < 20.5 && z > -5.5 && z < 1.5) return false;  // mosque hall
  if (x > -18 && x < -16 && z > -18 && z < 3.4) return false;    // boundary wall, north leg
  if (x > -18 && x < -16 && z > 11.4 && z < 32) return false;   // boundary wall, south leg
  if (x > 7.5 && x < 28.5 && z > 13.5 && z < 23.5) return false; // apartment row
  if (x > 30.5 && x < 39.5 && z > 13.5 && z < 22.5) return false; // hospital
  if (x > 23.5 && x < 30.5 && z > -5.5 && z < 1.5) return false;  // bank
  return true;
}

function scatterSlots(count, tries, seed) {
  const rnd = mulberry32(seed);
  const slots = [];
  for (let i = 0; i < tries && slots.length < count; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * 87;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (soilIsFree(x, z)) slots.push([x, z, rnd()]);
  }
  return { slots, rnd };
}

/* crossed-quad tuft: two vertical planes, blades alpha-cut from a
 * canvas, so each instance reads as a small clump of grass */
const tuftGeo = (() => {
  const w = 0.22, h = 0.2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    -w / 2, 0, 0, w / 2, 0, 0, w / 2, h, 0, -w / 2, h, 0,
    0, 0, -w / 2, 0, 0, w / 2, 0, h, w / 2, 0, h, -w / 2
  ], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([
    0, 0, 1, 0, 1, 1, 0, 1,
    0, 0, 1, 0, 1, 1, 0, 1
  ], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  geo.computeVertexNormals();
  return geo;
})();

const tuftTex = canvasTexture(64, 64, (g, w, h) => {
  const rnd = mulberry32(1234);
  for (let i = 0; i < 7; i++) {
    const bx = 6 + i * 8 + (rnd() - 0.5) * 4;
    const tx = bx + (rnd() - 0.5) * 18;
    const ty = h * (0.16 + rnd() * 0.4);
    const grad = g.createLinearGradient(0, h, 0, ty);
    grad.addColorStop(0, '#33501f');
    grad.addColorStop(1, '#8fb45c');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(bx - 2.4, h);
    g.quadraticCurveTo(bx + (rnd() - 0.5) * 8, h * 0.5, tx, ty);
    g.quadraticCurveTo(bx + (rnd() - 0.5) * 8 + 3, h * 0.5, bx + 2.4, h);
    g.closePath();
    g.fill();
  }
});

const tufts = new THREE.InstancedMesh(
  tuftGeo,
  new THREE.MeshStandardMaterial({ map: tuftTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 1 }),
  11000
);
{
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const { slots, rnd } = scatterSlots(11000, 40000, 90210);
  for (let i = 0; i < slots.length; i++) {
    const [x, z, q] = slots[i];
    dummy.position.set(x, 0, z);
    dummy.rotation.set(0, q * Math.PI, 0);
    const s = 0.75 + rnd() * 0.7;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    tufts.setMatrixAt(i, dummy.matrix);
    col.setHSL(0.24 + q * 0.05, 0.35 + q * 0.2, 0.32 + q * 0.16);
    tufts.setColorAt(i, col);
  }
  tufts.count = slots.length;
  tufts.instanceMatrix.needsUpdate = true;
  if (tufts.instanceColor) tufts.instanceColor.needsUpdate = true;
}
tufts.castShadow = false;
tufts.receiveShadow = false;
scene.add(tufts);

/* low bush clumps; same seed as the tufts, so every bush sits on a
 * grass slot and reads as one planted clump */
const bushes = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.3, 0),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }),
  300
);
{
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const { slots, rnd } = scatterSlots(300, 20000, 90210);
  for (let i = 0; i < slots.length; i++) {
    const [x, z, q] = slots[i];
    const s = 0.55 + rnd() * 1.15;
    dummy.position.set(x, 0.2 * s, z);
    dummy.rotation.set(rnd() * 0.6, q * Math.PI * 2, rnd() * 0.4);
    dummy.scale.set(s, s * (0.7 + rnd() * 0.5), s);
    dummy.updateMatrix();
    bushes.setMatrixAt(i, dummy.matrix);
    col.setHSL(0.27 + q * 0.05, 0.3 + q * 0.22, 0.22 + q * 0.14);
    bushes.setColorAt(i, col);
  }
  bushes.count = slots.length;
  bushes.instanceMatrix.needsUpdate = true;
  if (bushes.instanceColor) bushes.instanceColor.needsUpdate = true;
}
bushes.castShadow = true;
bushes.receiveShadow = true;
scene.add(bushes);

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

/* ------------------------------------------------------------------ *
 * Captions: the page's one authored motion. Each reveals when its
 * caption enters the viewport and stays revealed until the caption
 * has actually left it (threshold 0: any pixel counts), so the text
 * for a scene remains on screen until that scene has passed, exactly
 * like the walk does. IntersectionObserver instead of a scroll
 * listener: batched off the scroll frame, and it reports what is
 * actually on screen.
 * ------------------------------------------------------------------ */
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) e.target.classList.toggle('is-in', e.isIntersecting);
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0 });
  for (const c of document.querySelectorAll('.caption')) io.observe(c);
}

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
 *   bs_rot  : flat [frame, value, ...] angle about bs_axis (default glTF Y)
 *   bs_axis : "X" | "Y" | "Z" — rotation axis in glTF space (rot kind only)
 *   bs_pos  : flat [frame, x, y, z, ...] for the camera + its aim target
 *   bs_hide : frame before which the node (and its subtree) is not shown
 * ------------------------------------------------------------------ */

const parts = [];
const walkers = [];              // pedestrians: driven by wall clock, not scroll
const guards = [];               // the checkpoint guard: subtle idle, wall clock
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
const AXES = {
  X: new THREE.Vector3(1, 0, 0),
  Y: Y_AXIS,
  Z: new THREE.Vector3(0, 0, 1)
};
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
      _q.setFromAxisAngle(p.axis || Y_AXIS, rotAt(p.keys, f));
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
    const guardRoots = [];
    root.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
      if (o.name.startsWith('Ped_') && o.name.endsWith('_Root')) pedRoots.push(o);
      if (o.name === 'Guard_Root') guardRoots.push(o);
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
        p.axis = AXES[extra(o, 'bs_axis')] || Y_AXIS;
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

    /* The checkpoint guard keeps his post: same rig shape as a walker, but no
     * path. A slow weight-shift and a scan of the road, driven by the wall
     * clock, so he never looks like a shop mannequin. */
    guardRoots.forEach(rt => {
      const g = s => rt.getObjectByName('Guard_' + s);
      guards.push({ body: g('Body'), head: g('Head') });
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
      'could not load scene.glb: serve this folder over HTTP';
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
  if (f < 1130) return 'past the roundabout';
  if (f < 1185) return 'residential apartments';
  if (f < 1330) return 'the hospital';
  if (f < 1388) return 'the commercial bank';
  if (f < 1412) return 'residential apartments';
  return 'the whole society';
}

function updateGuards(t) {
  for (const g of guards) {
    if (g.body) {
      g.body.rotation.x = 0.030 * Math.sin(t * 0.60);         // weight shift
      g.body.rotation.y = 0.015 * Math.sin(t * 0.43 + 1.1);   // tiny bow
    }
    if (g.head) {
      g.head.rotation.z = 0.32 * Math.sin(t * 0.37);          // scans the road
      g.head.rotation.y = 0.10 * Math.sin(t * 0.90 + 0.5);    // small nods
    }
  }
}

function tick() {
  requestAnimationFrame(tick);

  const nowT = performance.now();
  const dt = Math.min(0.05, Math.max(0, (nowT - lastT) / 1000));   // clamp: no jump after tab-out
  lastT = nowT;

  /* gentler chase: the walk eases after the scroll instead of snapping to it,
     which reads slower and calmer without changing the scroll-to-frame map */
  scrollSmooth += (scrollTarget - scrollSmooth) * 0.07;
  const frameTarget = frameAtScroll(
    scrollSmooth * (document.documentElement.scrollHeight - window.innerHeight));
  frameCur += (frameTarget - frameCur) * 0.12;

  if (ready) {
    applyFrame(frameCur);
    if (!reduceMotion) { updateWalkers(dt); updateGuards(nowT / 1000); }
  }

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
