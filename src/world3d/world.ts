import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { STAGES, LOOKS } from "../sim/data";
import { Editor, store } from "../sim/store";
import { STATIONS, StationId, WORLD_H, WORLD_W, landSdf, DECK, DOCK } from "../world/layout";
import { clamp } from "../world/pixel";
import { Lantern, Screen, TreeSpot, buildBoat, buildCat, buildDuck, buildForest, buildHuts, buildLilies, buildMeadow, buildVilla, swayTime } from "./builders";
import { Character } from "./character";
import { S, groundY, terrainMesh, waterMesh, wx, wz } from "./terrain";

const YAW = 0.42;
const PITCH = 0.84;
const VIEW_HEIGHT = 42;

const HOME = new THREE.Vector3(-0.5, 1, 1.8);

/** Final picture: miniature focus falloff, warm grade and a gentle vignette. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uPixel: { value: new THREE.Vector2(1, 1) }, uNight: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uPixel;
    uniform float uNight;
    varying vec2 vUv;
    void main() {
      float away = abs(vUv.y - 0.52);
      float blur = smoothstep(0.2, 0.56, away) * 2.6;
      vec3 c = texture2D(tDiffuse, vUv).rgb * 0.28;
      for (int i = 0; i < 6; i++) {
        float a = float(i) * 1.047 + 0.4;
        c += texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * uPixel * blur).rgb * 0.12;
      }
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, 0.98);
      vec3 shadow = vec3(0.96, 0.94, 1.03);
      vec3 light = vec3(1.05, 1.0, 0.9);
      c *= mix(shadow, light, smoothstep(0.03, 0.55, l));
      vec2 q = vUv - 0.5;
      c *= 1.0 - dot(q, q) * 0.34;
      gl_FragColor = vec4(c, 1.0);
    }`,
};

type Particle = { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; kind: "petal" | "firefly" | "smoke" | "butterfly" | "mote"; seed: number; color: THREE.Color };
const MAX_P = 360;

export class World3D {
  renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 400);
  target = HOME.clone();
  private goal = this.target.clone();
  zoom = 1;
  private goalZoom = 1;
  private sun = new THREE.DirectionalLight("#fff1dc", 3);
  private hemi = new THREE.HemisphereLight("#fff4df", "#6f9c8a", 1.5);
  private water = waterMesh();
  private screens: Screen[] = [];
  private lanterns: Lantern[] = [];
  private chars = new Map<string, { c: Character; ring: THREE.Mesh; y: number }>();
  private cat = { ...buildCat(), x: 352, y: 345, tx: 352, ty: 345, mode: "sit" as "sit" | "walk" | "love", timer: 5, dir: 0 };
  private ducks: { g: THREE.Group; x: number; y: number; dir: number; timer: number }[] = [];
  private fish: { g: THREE.Mesh; x: number; y: number; a: number; speed: number; turn: number }[] = [];
  private birds: { g: THREE.Group; x: number; y: number; vx: number; flap: number; wings: THREE.Mesh[] }[] = [];
  private boat = buildBoat();
  private hammock!: THREE.Group;
  private trees: TreeSpot[] = [];
  private ripples: { m: THREE.Mesh; t: number }[] = [];
  private particles: Particle[] = [];
  private pGeo = new THREE.BufferGeometry();
  private pPos = new Float32Array(MAX_P * 3);
  private pCol = new Float32Array(MAX_P * 4);
  private spawn = { mote: 0, petal: 0, smoke: 0, firefly: 0, fly: 0, bird: 7, ripple: 1 };
  private time = 0;
  private screenClock = 0;
  private composer!: EffectComposer;
  private gtao!: GTAOPass;
  private grade!: ShaderPass;
  private slowFrames = 0;
  private sampled = 0;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.7);
  private hover: THREE.Mesh;
  reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  hoverStation: StationId | null = null;
  hoverEditor: string | null = null;
  width = 1;
  height = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.scene.background = new THREE.Color("#0b3f47");

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2560, 2560);
    const sc = this.sun.shadow.camera;
    sc.left = -66;
    sc.right = 66;
    sc.top = 52;
    sc.bottom = -52;
    sc.near = 1;
    sc.far = 230;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.radius = 7;
    this.sun.shadow.blurSamples = 16;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.scene.add(terrainMesh());
    this.scene.add(this.water.mesh);
    const catcher = new THREE.Mesh(new THREE.PlaneGeometry(300, 240), new THREE.ShadowMaterial({ opacity: 0.2, color: "#052530" }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = 0.012;
    catcher.receiveShadow = true;
    this.scene.add(catcher);

    this.scene.add(buildVilla(this.screens, this.lanterns));
    const huts = buildHuts(this.screens, this.lanterns);
    this.hammock = huts.hammock;
    this.scene.add(huts.root);
    const forest = buildForest();
    this.trees = forest.spots;
    this.scene.add(forest.root);
    this.scene.add(buildMeadow());
    this.scene.add(buildLilies());
    this.scene.add(this.cat.group);
    this.boat.visible = false;
    this.scene.add(this.boat);
    this.addCreatures();
    this.addParticles();

    this.hover = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: "#fff6e0", transparent: true, opacity: 0.12, depthWrite: false }));
    this.hover.rotation.x = -Math.PI / 2;
    this.hover.visible = false;
    this.scene.add(this.hover);
    this.setupPost();
  }

  private setupPost() {
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.gtao = new GTAOPass(this.scene, this.camera, 4, 4);
    this.gtao.blendIntensity = 0.85;
    this.gtao.updateGtaoMaterial({ radius: 1.6, distanceExponent: 1.4, thickness: 1.4, scale: 1.15, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    this.composer.addPass(this.gtao);
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.14, 0.7, 0.92));
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
  }

  /** Keeps it smooth on older Macs by dropping the most expensive effect. */
  private watchPerformance(dt: number) {
    if (this.sampled > 240 || !this.gtao.enabled) return;
    this.sampled++;
    if (this.sampled > 60 && dt > 0.03) this.slowFrames++;
    if (this.slowFrames > 70) {
      this.gtao.enabled = false;
      this.renderer.setPixelRatio(1);
      this.composer.setPixelRatio(1);
    }
  }

  private addCreatures() {
    const colors = ["#ff8a3c", "#fff0dd", "#f4503b", "#ffd04a"];
    const fishGeo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < 16; i++) {
      const g = new THREE.Mesh(fishGeo, new THREE.MeshStandardMaterial({ color: colors[i % 4], roughness: 0.4, transparent: true, opacity: 0.86 }));
      g.scale.set(0.15, 0.08, 0.42);
      g.position.y = 0.03;
      this.scene.add(g);
      this.fish.push({ g, x: 190 + Math.random() * 460, y: 374 + Math.random() * 112, a: Math.random() * 6.28, speed: 7 + Math.random() * 8, turn: Math.random() * 4 });
    }
    for (const [x, y] of [
      [500, 410],
      [516, 418],
      [530, 412],
    ]) {
      const g = buildDuck();
      this.scene.add(g);
      this.ducks.push({ g, x, y, dir: -1, timer: 3 + Math.random() * 3 });
    }
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      const m = new THREE.MeshStandardMaterial({ color: "#fff4df", side: THREE.DoubleSide, roughness: 0.8 });
      const wings = [-1, 1].map((d) => {
        const geo = new THREE.PlaneGeometry(0.46, 0.16);
        geo.rotateX(Math.PI / 2);
        geo.translate(0.23, 0, 0);
        const w = new THREE.Mesh(geo, m);
        w.scale.x = d;
        w.castShadow = true;
        g.add(w);
        return w;
      });
      g.visible = false;
      g.position.y = 17;
      this.scene.add(g);
      this.birds.push({ g, x: -999, y: 0, vx: 0, flap: Math.random() * 6, wings });
    }
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 32), new THREE.MeshBasicMaterial({ color: "#eafff4", transparent: true, opacity: 0, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.05;
      this.scene.add(m);
      this.ripples.push({ m, t: 9 });
    }
  }

  private addParticles() {
    this.pGeo.setAttribute("position", new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute("color", new THREE.BufferAttribute(this.pCol, 4));
    this.pGeo.setDrawRange(0, 0);
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(16, 16, 1, 16, 16, 16);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.45, "rgba(255,255,255,.75)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const pts = new THREE.Points(this.pGeo, new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, map: new THREE.CanvasTexture(c), vertexColors: true, transparent: true, depthWrite: false }));
    pts.frustumCulled = false;
    this.scene.add(pts);
  }

  resize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    (this.grade.uniforms.uPixel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.applyCamera();
  }

  private baseZoom() {
    return 1;
  }

  private applyCamera() {
    const aspect = this.width / this.height;
    const h = (VIEW_HEIGHT / 2) / this.zoom;
    const c = this.camera;
    c.top = h;
    c.bottom = -h;
    c.left = -h * aspect;
    c.right = h * aspect;
    const d = 130;
    c.position.set(this.target.x + Math.sin(YAW) * Math.cos(PITCH) * d, this.target.y + Math.sin(PITCH) * d, this.target.z + Math.cos(YAW) * Math.cos(PITCH) * d);
    c.lookAt(this.target);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }

  panBy(dxPx: number, dyPx: number) {
    const unit = (VIEW_HEIGHT / this.zoom) / this.height;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
    const fwd = new THREE.Vector3(-Math.sin(YAW), 0, -Math.cos(YAW));
    this.goal.addScaledVector(right, -dxPx * unit);
    this.goal.addScaledVector(fwd, (dyPx * unit) / Math.sin(PITCH));
    this.clampGoal();
    this.target.copy(this.goal);
  }

  zoomBy(dir: number) {
    this.goalZoom = clamp(this.goalZoom * (dir > 0 ? 1.18 : 1 / 1.18), this.baseZoom(), 3);
  }

  focus(px: number, py: number, offsetPx: number) {
    const unit = (VIEW_HEIGHT / this.zoom) / this.height;
    this.goal.set(wx(px), 1, wz(py));
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
    this.goal.addScaledVector(right, offsetPx * unit);
    this.clampGoal();
  }

  home() {
    this.goal.copy(HOME);
    this.goalZoom = 1;
  }

  private clampGoal() {
    this.goal.x = clamp(this.goal.x, -24, 22);
    this.goal.z = clamp(this.goal.z, -12, 15);
  }

  /** Converts a screen point to map pixels on the ground. */
  groundAt(px: number, py: number) {
    const ndc = new THREE.Vector2((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.plane, hit)) return null;
    return { x: hit.x / S + 390, y: hit.z / S + 250 };
  }

  project(x: number, y: number, h: number) {
    const v = new THREE.Vector3(x, y, h).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.width, y: ((1 - v.y) / 2) * this.height };
  }

  editorAt(px: number, py: number) {
    let best: Editor | null = null;
    let bestDist = 34 * this.zoom;
    for (const e of store.editors) {
      const c = this.chars.get(e.id);
      if (!c) continue;
      const p = c.c.group.position;
      const s = this.project(p.x, p.y + 1.8, p.z);
      const d = Math.hypot(px - s.x, py - s.y);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  stationAt(x: number, y: number) {
    for (const s of Object.values(STATIONS)) {
      if (x >= s.area.x && x < s.area.x + s.area.w && y >= s.area.y && y < s.area.y + s.area.h) return s.id;
    }
    return null;
  }

  private onDeck(x: number, y: number) {
    const inR = (r: { x: number; y: number; w: number; h: number }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    return inR(DECK) || inR(DOCK);
  }

  ripple(x: number, y: number) {
    const free = this.ripples.find((r) => r.t > 2);
    if (!free) return;
    free.t = 0;
    free.m.position.x = wx(x);
    free.m.position.z = wz(y);
  }

  private addParticle(p: Omit<Particle, "color"> & { color: string }) {
    if (this.particles.length >= MAX_P) return;
    this.particles.push({ ...p, color: new THREE.Color(p.color) });
  }

  poke(x: number, y: number) {
    if (Math.hypot(x - this.cat.x, y - this.cat.y) < 18) {
      this.cat.mode = "love";
      this.cat.timer = 2.6;
      for (let i = 0; i < 9; i++) {
        this.addParticle({ x: wx(this.cat.x) + (Math.random() - 0.5) * 1.2, y: 2 + Math.random(), z: wz(this.cat.y), vx: (Math.random() - 0.5) * 0.4, vy: 1 + Math.random(), vz: 0, life: 1.4, max: 1.4, kind: "smoke", seed: 1, color: "#ff6b8a" });
      }
      return true;
    }
    for (const t of this.trees) {
      if (Math.hypot(x - t.x, (y - t.y) * 1.2) < t.r) {
        for (let i = 0; i < 18; i++) {
          this.addParticle({ x: wx(t.x) + (Math.random() - 0.5) * 3, y: 3 + Math.random() * 3, z: wz(t.y) + (Math.random() - 0.5) * 3, vx: (Math.random() - 0.5) * 1.3, vy: -1.2 - Math.random(), vz: (Math.random() - 0.5) * 1.3, life: 2.4 + Math.random(), max: 3.4, kind: "petal", seed: Math.random() * 9, color: Math.random() > 0.5 ? "#f7ac3b" : "#6fcf8a" });
        }
        return true;
      }
    }
    if (landSdf(x, y) < 0 && !this.onDeck(x, y)) {
      this.ripple(x, y);
      for (const f of this.fish) if (Math.hypot(f.x - x, f.y - y) < 70) f.a = Math.atan2(f.y - y, f.x - x);
      return true;
    }
    return false;
  }

  private night() {
    const h = store.clock;
    if (h >= 20 || h < 5) return 1;
    if (h >= 17.8) return (h - 17.8) / 2.2;
    if (h < 7) return 1 - (h - 5) / 2;
    return 0;
  }

  private updateLight() {
    const h = store.clock;
    const night = this.night();
    const golden = h > 14.5 && h < 19.5 ? 1 - Math.abs(h - 17.6) / 3.1 : h > 5 && h < 8.5 ? 1 - Math.abs(h - 6.6) / 1.9 : 0;
    const warm = clamp(golden, 0, 1);
    const dayArc = clamp((h - 6) / 12, 0, 1) * Math.PI;
    const el = Math.max(Math.sin(dayArc) * 0.42 + 0.46, 0.4) - warm * 0.08;
    const az = 1.25 - clamp((h - 6) / 12, 0, 1) * 2.1;
    const moon = night > 0.6;
    const pos = moon ? new THREE.Vector3(36, 80, 48) : new THREE.Vector3(-Math.cos(az) * 62 - 8, el * 92, Math.abs(Math.sin(az)) * 24 + 54);
    this.sun.position.copy(pos);
    this.sun.target.position.set(2, 0, 2);
    const day = new THREE.Color("#fff1dc").lerp(new THREE.Color("#ffa862"), warm);
    this.sun.color.copy(day).lerp(new THREE.Color("#8fa8ff"), night);
    this.sun.intensity = (2.5 + warm * 0.9) * (1 - night) + 0.7 * night;
    this.hemi.intensity = (1.5 - warm * 0.45) * (1 - night) + 0.5 * night;
    this.hemi.color.set("#fff2df").lerp(new THREE.Color("#7f96e8"), night);
    this.hemi.groundColor.set("#c9a678").lerp(new THREE.Color("#1c2f4a"), night);
    const water = new THREE.Color(1, 1, 1).lerp(new THREE.Color(1.08, 0.96, 0.84), warm * 0.6).lerp(new THREE.Color(0.2, 0.28, 0.55), night * 0.92);
    (this.water.material.uniforms.uLight.value as THREE.Color).copy(water);
    for (const l of this.lanterns) {
      if (l.light) l.light.intensity = night * 26;
      l.glow.color.set("#7d5b3a").lerp(new THREE.Color("#ffd98a"), Math.max(night, 0.08));
    }
  }

  private drawScreens(t: number) {
    const rendering = store.editors.find((e) => e.activity === "working" && STAGES[e.stage].id === "render");
    const waiting = store.editors.some((e) => e.mission && STAGES[e.stage].id === "review");
    for (const s of this.screens) {
      const g = s.ctx;
      const active = store.editors.some((e) => e.station === s.station && e.activity === "working") || (s.station === "review" && waiting);
      const { w, h } = s;
      g.fillStyle = "#0f2733";
      g.fillRect(0, 0, w, h);
      if (active) {
        if (s.station === "cutting") {
          g.fillStyle = "#1a3c4b";
          g.fillRect(4, 4, w * 0.52, h * 0.56);
          g.fillStyle = "#e6b35f";
          g.fillRect(12, 12, w * 0.3, h * 0.34);
          const colors = ["#e8772e", "#2aa394", "#f0b63c", "#7f62c4"];
          for (let i = 0; i < 11; i++) {
            g.fillStyle = colors[i % 4];
            g.fillRect(8 + i * 17, h * 0.72, 15, 9);
            g.fillRect(14 + i * 17, h * 0.86, 12, 7);
          }
          g.fillStyle = "#fff";
          g.fillRect(6 + ((t * 18) % (w - 12)), h * 0.66, 2, h * 0.32);
        } else if (s.station === "animation") {
          g.fillStyle = "#27335a";
          g.fillRect(0, 0, w, h);
          const r = 11 + Math.sin(t * 2) * 7;
          g.fillStyle = "#f0b63c";
          g.beginPath();
          g.arc(w * 0.35, h * 0.5, r, 0, 6.3);
          g.fill();
          g.fillStyle = "#ff7a59";
          g.fillRect(w * 0.5 + Math.sin(t * 1.6) * 34, h * 0.32, 26, 22);
          g.fillStyle = "#70d6b4";
          g.fillRect(14, h - 12, ((t * 16) % 1) * 0 + (w - 28) * ((t * 0.2) % 1), 5);
        } else if (s.station === "captions") {
          g.fillStyle = "#fff";
          g.fillRect(16, h * 0.44, w - 32, h * 0.2);
          g.fillStyle = "#f0b63c";
          g.fillRect(16, h * 0.44, (w - 32) * ((t * 0.3) % 1), h * 0.2);
        } else if (s.station === "sound") {
          for (let i = 0; i < 30; i++) {
            const v = (Math.sin(t * 5 + i * 1.4) + 1.1) * 0.32 * h;
            g.fillStyle = i > 23 ? "#ff7a59" : "#70d6b4";
            g.fillRect(4 + i * 6.2, h - 3 - v, 4, v);
          }
        } else if (s.station === "render") {
          g.fillStyle = "#27424b";
          g.fillRect(12, h * 0.45, w - 24, 12);
          g.fillStyle = "#70d6b4";
          g.fillRect(12, h * 0.45, (w - 24) * (rendering?.stageProgress ?? 0.5), 12);
        } else {
          g.fillStyle = "#274a6b";
          g.fillRect(0, 0, w, h);
          g.fillStyle = "#fff";
          g.beginPath();
          g.moveTo(w / 2 - 12, h / 2 - 15);
          g.lineTo(w / 2 + 16, h / 2);
          g.lineTo(w / 2 - 12, h / 2 + 15);
          g.fill();
        }
      } else {
        g.fillStyle = "#183945";
        g.fillRect(w / 2 - 12, h / 2 - 1, 24, 2);
      }
      s.tex.needsUpdate = true;
    }
  }

  private syncEditors(t: number, dt: number) {
    const seen = new Set<string>();
    for (const e of store.editors) {
      seen.add(e.id);
      let rec = this.chars.get(e.id);
      if (!rec) {
        const c = new Character(LOOKS[e.look]);
        c.group.scale.setScalar(1.34);
        const ring = new THREE.Mesh(new THREE.RingGeometry(1.02, 1.1, 48), new THREE.MeshBasicMaterial({ color: LOOKS[e.look].shirt, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        this.scene.add(c.group, ring);
        rec = { c, ring, y: groundY(e.x, e.y) };
        this.chars.set(e.id, rec);
      }
      const on = store.boat.passenger === e;
      const gy = on ? 0.95 : groundY(e.x, e.y);
      rec.y += (gy - rec.y) * Math.min(1, dt * 12);
      const g = rec.c.group;
      const resting = e.activity === "resting";
      g.position.set(wx(e.x), resting ? 0.86 + Math.sin(t * 1.1) * 0.05 : rec.y, wz(e.y));
      rec.c.setFacing(e.face, dt);
      rec.c.animate(e.pose, e.anim);
      const selected = store.selectedId === e.id;
      const hovered = this.hoverEditor === e.id;
      rec.ring.visible = !resting && (selected || hovered);
      rec.ring.position.set(g.position.x, rec.y + 0.05, g.position.z);
      rec.ring.scale.setScalar(1 + Math.sin(t * 3) * 0.04);
      (rec.ring.material as THREE.MeshBasicMaterial).opacity = 0.9;
    }
    for (const [id, rec] of this.chars) {
      if (!seen.has(id)) {
        this.scene.remove(rec.c.group, rec.ring);
        this.chars.delete(id);
      }
    }
  }

  private updateAmbient(dt: number) {
    const t = this.time;
    const night = this.night();
    const s = this.spawn;

    for (const f of this.fish) {
      f.turn -= dt;
      if (f.turn <= 0) {
        f.turn = 1.5 + Math.random() * 3;
        f.a += (Math.random() - 0.5) * 1.8;
      }
      f.x += Math.cos(f.a) * f.speed * dt;
      f.y += Math.sin(f.a) * f.speed * dt * 0.6;
      if (f.y < 370 || f.y > 494 || f.x < 150 || f.x > 690 || landSdf(f.x, f.y) > -9) {
        f.a += 2.6;
        f.x = clamp(f.x, 152, 688);
        f.y = clamp(f.y, 372, 492);
      }
      f.g.position.x = wx(f.x);
      f.g.position.z = wz(f.y);
      f.g.rotation.y = -f.a + Math.PI / 2 + Math.sin(t * 8 + f.x) * 0.16;
    }

    for (const d of this.ducks) {
      d.timer -= dt;
      d.x += d.dir * dt * 5;
      if (d.timer <= 0) {
        d.timer = 6 + Math.random() * 7;
        if (d.x < 450) d.dir = 1;
        else if (d.x > 640) d.dir = -1;
        else if (Math.random() > 0.65) d.dir *= -1;
      }
      d.g.position.set(wx(d.x), Math.sin(t * 2 + d.x) * 0.025, wz(d.y));
      d.g.rotation.y = d.dir * (Math.PI / 2);
    }

    const c = this.cat;
    c.timer -= dt;
    if (c.mode === "walk") {
      const dx = c.tx - c.x;
      const dy = c.ty - c.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) {
        c.mode = "sit";
        c.timer = 8 + Math.random() * 12;
      } else {
        c.x += (dx / dist) * dt * 15;
        c.y += (dy / dist) * dt * 15;
        c.dir = Math.atan2(dx, dy);
      }
    } else if (c.timer <= 0) {
      const spots = [
        [352, 345],
        [440, 342],
        [320, 346],
        [392, 400],
        [392, 345],
        [460, 340],
      ];
      [c.tx, c.ty] = spots[Math.floor(Math.random() * spots.length)];
      c.mode = "walk";
    }
    c.group.position.set(wx(c.x), groundY(c.x, c.y) + (c.mode === "walk" ? Math.abs(Math.sin(t * 9)) * 0.05 : 0), wz(c.y));
    c.group.rotation.y = c.mode === "love" ? Math.sin(t * 10) * 0.2 : c.mode === "walk" ? c.dir : 0.35;
    c.tail.rotation.z = Math.sin(t * (c.mode === "walk" ? 7 : 2)) * 0.32;

    const b = store.boat;
    this.boat.visible = b.state !== "away";
    this.boat.position.set(wx(b.x), Math.sin(t * 1.4) * 0.05, wz(442));
    this.boat.rotation.z = Math.sin(t * 1.1) * 0.012;
    this.hammock.rotation.x = Math.sin(t * 1.1) * 0.012;

    for (const r of this.ripples) {
      r.t += dt;
      const on = r.t < 2;
      r.m.visible = on;
      if (on) {
        r.m.scale.setScalar(0.2 + r.t * 1.6);
        (r.m.material as THREE.MeshBasicMaterial).opacity = (1 - r.t / 2) * 0.75;
      }
    }

    for (const bird of this.birds) {
      if (!bird.g.visible) continue;
      bird.x += bird.vx * dt;
      bird.flap += dt * 10;
      bird.g.position.x = wx(bird.x);
      bird.g.position.z = wz(bird.y);
      const a = Math.sin(bird.flap) * 0.65;
      bird.wings[0].rotation.z = a;
      bird.wings[1].rotation.z = -a;
      if (bird.x > WORLD_W + 120) bird.g.visible = false;
    }
    s.bird -= dt;
    if (s.bird <= 0) {
      s.bird = 11 + Math.random() * 15;
      const y = 40 + Math.random() * 300;
      this.birds.forEach((v, i) => {
        v.x = -90 - i * 22;
        v.y = y + (i % 2) * 18 + i * 5;
        v.vx = 52;
        v.g.visible = true;
      });
    }

    s.petal -= dt;
    if (s.petal <= 0) {
      s.petal = 0.45 + Math.random() * 0.8;
      const tr = this.trees[Math.floor(Math.random() * this.trees.length)];
      this.addParticle({ x: wx(tr.x), y: 5, z: wz(tr.y), vx: 0.5 + Math.random() * 0.7, vy: -0.8 - Math.random() * 0.5, vz: Math.random() * 0.4, life: 4.4, max: 4.4, kind: "petal", seed: Math.random() * 9, color: ["#ffd76a", "#f7ac3b", "#fff3d1", "#ef8fa8"][Math.floor(Math.random() * 4)] });
    }
    s.mote -= dt;
    if (s.mote <= 0 && night < 0.6) {
      s.mote = 0.05;
      this.addParticle({ x: this.target.x + (Math.random() - 0.5) * 70, y: 1 + Math.random() * 7, z: this.target.z + (Math.random() - 0.5) * 50, vx: 0.14 + Math.random() * 0.2, vy: 0.05, vz: 0.06, life: 7, max: 7, kind: "mote", seed: Math.random() * 9, color: "#ffdf9e" });
    }
    s.smoke -= dt;
    const rendering = store.editors.some((e) => e.activity === "working" && STAGES[e.stage].id === "render");
    if (s.smoke <= 0) {
      s.smoke = rendering ? 0.2 : 0.55;
      this.addParticle({ x: wx(660) + Math.random() * 0.3, y: 7, z: wz(164), vx: 0.4 + Math.random() * 0.3, vy: 1.1 + Math.random() * 0.5, vz: 0, life: 3.2, max: 3.2, kind: "smoke", seed: 0, color: "#ffffff" });
    }
    s.ripple -= dt;
    if (s.ripple <= 0) {
      s.ripple = 1.6 + Math.random() * 2.3;
      const x = 170 + Math.random() * 520;
      const y = 372 + Math.random() * 118;
      if (landSdf(x, y) < -8 && !this.onDeck(x, y)) this.ripple(x, y);
    }
    s.firefly -= dt;
    if (s.firefly <= 0) {
      s.firefly = night > 0.4 ? 0.07 : 2;
      if (night > 0.4) this.addParticle({ x: wx(Math.random() * WORLD_W), y: 0.6 + Math.random() * 3, z: wz(Math.random() * WORLD_H), vx: 0, vy: 0, vz: 0, life: 4 + Math.random() * 3, max: 7, kind: "firefly", seed: Math.random() * 9, color: "#fff27a" });
    }
    s.fly -= dt;
    if (s.fly <= 0 && night < 0.5) {
      s.fly = 1.7 + Math.random() * 2;
      const x = 60 + Math.random() * 650;
      const y = 80 + Math.random() * 250;
      if (landSdf(x, y) > 10) this.addParticle({ x: wx(x), y: 1.5 + Math.random() * 1.6, z: wz(y), vx: (Math.random() - 0.5) * 1.3, vy: 0, vz: (Math.random() - 0.5) * 1.3, life: 10, max: 10, kind: "butterfly", seed: Math.random() * 9, color: ["#ffb347", "#ffffff", "#ff7fa8", "#7fd6ff"][Math.floor(Math.random() * 4)] });
    }

    let n = 0;
    for (const p of this.particles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.kind === "petal") p.x += Math.sin(t * 2.2 + p.seed) * 0.012;
      if (p.kind === "firefly") {
        p.x += Math.sin(t * 1.3 + p.seed) * 0.02;
        p.z += Math.cos(t * 1.7 + p.seed) * 0.02;
      }
      if (p.kind === "butterfly") {
        p.x += Math.sin(t * 1.3 + p.seed) * 0.03;
        p.y += Math.sin(t * 7 + p.seed) * 0.012;
      }
      const k = p.life / p.max;
      let a = 1;
      if (p.kind === "smoke") a = k * 0.42;
      if (p.kind === "firefly") a = (Math.sin(t * 3 + p.seed) + 1) / 2;
      if (p.kind === "petal") a = Math.min(1, p.life * 2);
      if (p.kind === "mote") a = Math.sin(k * Math.PI) * 0.45;
      if (p.kind === "butterfly") a = Math.sin(t * 22 + p.seed) > -0.4 ? 1 : 0.35;
      this.pPos[n * 3] = p.x;
      this.pPos[n * 3 + 1] = p.y;
      this.pPos[n * 3 + 2] = p.z;
      this.pCol[n * 4] = p.color.r;
      this.pCol[n * 4 + 1] = p.color.g;
      this.pCol[n * 4 + 2] = p.color.b;
      this.pCol[n * 4 + 3] = a;
      n++;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    this.pGeo.setDrawRange(0, n);
    this.pGeo.attributes.position.needsUpdate = true;
    this.pGeo.attributes.color.needsUpdate = true;
  }

  private updateHover() {
    const a = this.hoverStation ? STATIONS[this.hoverStation].area : null;
    this.hover.visible = !!a;
    if (a) {
      this.hover.scale.set(a.w * S, a.h * S, 1);
      this.hover.position.set(wx(a.x + a.w / 2), this.hoverStation === "hammock" || this.hoverStation === "review" || this.hoverStation === "render" ? 0.92 : 1.16, wz(a.y + a.h / 2));
    }
  }

  frame(dt: number) {
    const step = this.reducedMotion ? 0 : dt;
    this.time += step;
    const t = this.time;
    swayTime.value = t;
    this.water.material.uniforms.uTime.value = t;

    this.target.lerp(this.goal, Math.min(1, dt * 5));
    this.zoom += (this.goalZoom - this.zoom) * Math.min(1, dt * 7);
    this.applyCamera();

    this.updateLight();
    this.syncEditors(t, dt);
    this.updateAmbient(step);
    this.updateHover();
    this.screenClock -= dt;
    if (this.screenClock <= 0) {
      this.screenClock = 0.12;
      this.drawScreens(t);
    }
    this.grade.uniforms.uNight.value = this.night();
    this.composer.render(dt);
    this.watchPerformance(dt);
  }

  anchor(editorId: string) {
    const rec = this.chars.get(editorId);
    if (!rec) return null;
    const p = rec.c.group.position;
    return this.project(p.x, rec.y + 4.05, p.z);
  }

  dispose() {
    this.renderer.dispose();
  }
}
