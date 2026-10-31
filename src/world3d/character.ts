import * as THREE from "three";
import { Facing } from "../world/layout";
import { Look, Pose } from "./types";

const std = (color: string, roughness = 0.62) => new THREE.MeshStandardMaterial({ color, roughness });

const geo = {
  head: new THREE.SphereGeometry(0.64, 26, 20),
  torso: new THREE.CapsuleGeometry(0.42, 0.42, 6, 18),
  limb: new THREE.CapsuleGeometry(0.135, 0.44, 4, 10),
  leg: new THREE.CapsuleGeometry(0.17, 0.32, 4, 10),
  hand: new THREE.SphereGeometry(0.15, 12, 10),
  shoe: new THREE.SphereGeometry(0.22, 14, 10),
  eye: new THREE.SphereGeometry(0.105, 12, 10),
  glint: new THREE.SphereGeometry(0.035, 8, 6),
  blush: new THREE.CircleGeometry(0.1, 12),
  ball: new THREE.SphereGeometry(1, 18, 14),
};

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx) {
  const v = new THREE.Mesh(g, m);
  v.position.set(x, y, z);
  v.scale.set(sx, sy, sz);
  v.castShadow = true;
  return v;
}

function addHair(head: THREE.Group, look: Look) {
  const hair = std(look.hair, 0.55);
  const ball = geo.ball;
  const cap = (sy: number, y: number, z = -0.08) => head.add(mesh(ball, hair, 0, y, z, 0.68, sy, 0.68));
  switch (look.hairStyle) {
    case "short":
      cap(0.5, 0.26);
      head.add(mesh(ball, hair, 0.24, 0.5, 0.42, 0.26, 0.15, 0.2));
      break;
    case "long":
      cap(0.52, 0.25);
      head.add(mesh(ball, hair, 0, -0.32, -0.33, 0.62, 0.86, 0.34));
      head.add(mesh(ball, hair, -0.58, -0.2, 0.06, 0.15, 0.6, 0.24));
      head.add(mesh(ball, hair, 0.58, -0.2, 0.06, 0.15, 0.6, 0.24));
      break;
    case "bun":
      cap(0.52, 0.25);
      head.add(mesh(ball, hair, 0, 0.86, -0.12, 0.29));
      break;
    case "bob":
      cap(0.54, 0.24);
      head.add(mesh(ball, hair, -0.56, -0.08, -0.02, 0.2, 0.45, 0.42));
      head.add(mesh(ball, hair, 0.56, -0.08, -0.02, 0.2, 0.45, 0.42));
      head.add(mesh(ball, hair, 0, -0.08, -0.44, 0.58, 0.48, 0.24));
      break;
    case "curly":
      for (let i = 0; i < 13; i++) {
        const a = (i / 13) * Math.PI * 2;
        const r = i % 2 ? 0.52 : 0.28;
        head.add(mesh(ball, hair, Math.cos(a) * r, 0.5 + (i % 3) * 0.05, Math.sin(a) * r - 0.12, 0.29));
      }
      break;
    case "afro":
      head.add(mesh(ball, hair, 0, 0.32, -0.12, 0.92, 0.84, 0.88));
      break;
    case "cap": {
      const color = std(look.shirt, 0.5);
      head.add(mesh(ball, color, 0, 0.27, -0.03, 0.69, 0.48, 0.69));
      head.add(mesh(ball, color, 0, 0.26, 0.56, 0.5, 0.07, 0.42));
      break;
    }
    case "udeng": {
      // Balinese udeng headcloth with its small front fold.
      cap(0.48, 0.2);
      const cloth = std("#f3eede", 0.5);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.14, 10, 26), cloth);
      band.rotation.x = Math.PI / 2 - 0.12;
      band.position.y = 0.3;
      band.castShadow = true;
      head.add(band);
      head.add(mesh(ball, cloth, 0, 0.52, 0.5, 0.17, 0.24, 0.12));
      break;
    }
    default:
  }
}

export class Character {
  group = new THREE.Group();
  private body = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private prop = new THREE.Group();
  private book: THREE.Mesh;
  private mug: THREE.Mesh;
  private eyes: THREE.Mesh[] = [];
  private angle = 0;

  constructor(look: Look) {
    const skin = std(look.skin);
    const shirt = std(look.shirt, 0.56);
    const pants = std(look.pants);
    const shoe = std(look.shoes, 0.5);

    this.body.position.y = 0.72;
    this.body.add(mesh(geo.torso, shirt, 0, 0.5, 0));
    this.group.add(this.body);

    for (const [leg, x] of [
      [this.legL, -0.2],
      [this.legR, 0.2],
    ] as const) {
      leg.position.set(x, 0.74, 0);
      leg.add(mesh(geo.leg, pants, 0, -0.3, 0));
      leg.add(mesh(geo.shoe, shoe, 0, -0.62, 0.08, 1, 0.56, 1.3));
      this.group.add(leg);
    }

    for (const [arm, x] of [
      [this.armL, -0.54],
      [this.armR, 0.54],
    ] as const) {
      arm.position.set(x, 0.86, 0);
      arm.add(mesh(geo.limb, shirt, 0, -0.26, 0));
      arm.add(mesh(geo.hand, skin, 0, -0.56, 0));
      this.body.add(arm);
    }

    this.head.position.y = 1.62;
    this.head.add(mesh(geo.head, skin));
    const ink = new THREE.MeshStandardMaterial({ color: "#20161a", roughness: 0.25 });
    const white = new THREE.MeshBasicMaterial({ color: "#ffffff" });
    for (const x of [-0.25, 0.25]) {
      const eye = mesh(geo.eye, ink, x, -0.03, 0.57, 1, 1.25, 0.6);
      eye.add(mesh(geo.glint, white, 0.03, 0.04, 0.09));
      this.eyes.push(eye);
      this.head.add(eye);
      const blush = new THREE.Mesh(geo.blush, new THREE.MeshBasicMaterial({ color: "#ff8f7a", transparent: true, opacity: 0.32 }));
      blush.position.set(x * 1.45, -0.21, 0.54);
      blush.rotation.y = x * 1.1;
      this.head.add(blush);
    }
    addHair(this.head, look);

    if (look.headphones) {
      const m = std(look.headphones, 0.4);
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.71, 0.06, 8, 24, Math.PI), m);
      band.position.y = 0.05;
      this.head.add(band);
      this.head.add(mesh(geo.ball, m, -0.69, 0.02, 0, 0.13, 0.25, 0.22));
      this.head.add(mesh(geo.ball, m, 0.69, 0.02, 0, 0.13, 0.25, 0.22));
    }
    if (look.glasses) {
      const m = new THREE.MeshStandardMaterial({ color: "#1d1720", roughness: 0.3 });
      for (const x of [-0.25, 0.25]) {
        const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 8, 18), m);
        rim.position.set(x, -0.03, 0.62);
        this.head.add(rim);
      }
    }
    this.body.add(this.head);

    this.book = mesh(new THREE.BoxGeometry(0.72, 0.5, 0.08), std("#e8772e"), 0, 0.5, 0.56);
    this.book.rotation.x = -0.6;
    this.mug = mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.24, 12), std("#f6f0e4"), 0, 0, 0);
    this.prop.add(this.book);
    this.body.add(this.prop);
    this.armR.add(this.mug);
    this.mug.position.set(0, -0.72, 0.08);
  }

  setFacing(face: Facing, dt: number) {
    const target = { down: 0, up: Math.PI, right: Math.PI / 2, left: -Math.PI / 2 }[face];
    let d = target - this.angle;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.angle += d * Math.min(1, dt * 10);
    this.group.rotation.y = this.angle;
  }

  animate(pose: Pose, t: number) {
    const { armL, armR, legL, legR, body, head } = this;
    let aL = 0;
    let aR = 0;
    let zL = 0.08;
    let zR = -0.08;
    let l = 0;
    let bob = Math.sin(t * 2.2) * 0.022;
    let nod = 0;
    let turn = 0;
    let tilt = 0;
    let lift = 0;
    this.book.visible = pose === "read";
    this.mug.visible = pose === "coffee";
    this.group.rotation.z = 0;
    this.group.rotation.x = 0;

    switch (pose) {
      case "walk":
        l = Math.sin(t * 11) * 0.72;
        aL = -l * 0.8;
        aR = l * 0.8;
        bob = Math.abs(Math.cos(t * 11)) * 0.075;
        break;
      case "type":
        aL = -1.15 + Math.sin(t * 15) * 0.13;
        aR = -1.15 + Math.sin(t * 15 + 2) * 0.13;
        nod = 0.14 + Math.sin(t * 1.3) * 0.06;
        turn = Math.sin(t * 0.8) * 0.15;
        break;
      case "read":
        aL = -1.05;
        aR = -1.05;
        nod = 0.32 + Math.sin(t * 0.9) * 0.05;
        break;
      case "watch":
        aL = -0.15;
        aR = -0.15;
        zL = 0.32;
        zR = -0.32;
        turn = Math.sin(t * 0.7) * 0.35;
        break;
      case "think":
        aR = -2.15;
        zR = 0.42;
        nod = -0.14;
        turn = 0.25;
        break;
      case "hand":
        aR = Math.PI;
        zR = -0.25 + Math.sin(t * 9) * 0.28;
        bob = Math.abs(Math.sin(t * 5)) * 0.12;
        break;
      case "coffee":
        aR = -1.4 + Math.sin(t * 0.9) * 0.55;
        nod = Math.sin(t * 0.9) > 0.45 ? -0.2 : 0;
        break;
      case "chat":
        aL = Math.sin(t * 5) * 0.3 - 0.35;
        aR = -Math.sin(t * 4) * 0.3 - 0.35;
        nod = Math.sin(t * 6) * 0.06;
        break;
      case "cheer":
        aL = Math.PI - 0.2;
        aR = Math.PI - 0.2;
        zL = 0.32;
        zR = -0.32;
        lift = Math.abs(Math.sin(t * 7)) * 0.45;
        break;
      case "slump":
        aL = -0.1;
        aR = -0.1;
        nod = 0.42;
        tilt = Math.sin(t * 1.2) * 0.12;
        body.rotation.x = 0.24;
        break;
      case "sleep":
        this.group.rotation.z = Math.PI / 2;
        this.group.position.y += 0.28;
        break;
      default:
    }
    if (pose !== "slump") body.rotation.x = pose === "walk" ? 0.07 : 0;
    armL.rotation.x = aL;
    armR.rotation.x = aR;
    armL.rotation.z = zL;
    armR.rotation.z = zR;
    legL.rotation.x = l;
    legR.rotation.x = -l;
    body.position.y = 0.72 + bob + lift;
    legL.position.y = legR.position.y = 0.74 + lift;
    head.rotation.set(nod, turn, tilt);
    const blink = t % 3.7 < 0.11 || pose === "sleep" ? 0.12 : 1.25;
    this.eyes.forEach((e) => (e.scale.y = blink));
  }
}

const cache = new Map<number, string>();

/** One crisp 3D portrait per look, shared by the roster and the chat header. */
export function portraitFor(index: number, look: Look) {
  const hit = cache.get(index);
  if (hit) return hit;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(192, 192);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#fff6e0", "#7f9f90", 2.2));
  const sun = new THREE.DirectionalLight("#ffffff", 2.4);
  sun.position.set(2, 4, 5);
  scene.add(sun);
  const c = new Character(look);
  c.animate("stand", 0);
  c.group.rotation.y = -0.28;
  scene.add(c.group);
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 30);
  camera.position.set(0, 2.5, 7);
  camera.lookAt(0, 2.05, 0);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  renderer.dispose();
  renderer.forceContextLoss();
  cache.set(index, url);
  return url;
}
