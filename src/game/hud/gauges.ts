import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HudMaterials } from './materials';
import { SevenSegment, Text3D, textGeometry, type Font } from './text';

const START = Math.PI * 1.25; // 7:30 position
const END = -Math.PI * 0.25; // 4:30 position
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);

/** Instanced radial tick marks between two angles. */
function ticks(count: number, r0: number, r1: number, width: number, depth: number, a0: number, a1: number, mat: THREE.Material, skip?: (i: number) => boolean) {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    if (skip?.(i)) continue;
    const a = count === 1 ? a0 : a0 + ((a1 - a0) * i) / (count - 1);
    const r = (r0 + r1) / 2;
    _q.setFromAxisAngle(Z, a);
    _m.compose(_p.set(Math.cos(a) * r, Math.sin(a) * r, depth / 2), _q, _s.set(r1 - r0, width, depth));
    mesh.setMatrixAt(n++, _m);
  }
  mesh.count = n;
  mesh.computeBoundingSphere();
  return mesh;
}

/** All the labels for a dial merged into one geometry: one draw call. */
function labels(font: Font, items: { text: string; x: number; y: number }[], size: number) {
  const geos = items.map(({ text, x, y }) => textGeometry(font, text, { size, depth: size * 0.12, bevel: 0 }).clone().translate(x, y, 0));
  return mergeGeometries(geos);
}

export interface DialOptions {
  radius: number;
  max: number;
  /** Value between labels. */
  labelStep: number;
  /** Minor ticks per label step. */
  minor: number;
  /** Only number every n-th major tick (default 1). */
  labelEvery?: number;
  label: (v: number) => string;
  title: string;
  redFrom?: number;
}

/**
 * Chrome-bezel analog gauge: case, face, instanced ticks, merged numerals, a
 * red zone, a sprung needle and a glass front.
 */
export class Dial {
  readonly group = new THREE.Group();
  readonly face = new THREE.Group();
  private needle = new THREE.Group();
  private angle = START;
  private vel = 0;

  constructor(font: Font, M: HudMaterials, private o: DialOptions) {
    const R = o.radius;
    // Case and bezel.
    const caseMesh = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.06, R * 1.1, R * 0.3, 48), M.gunmetal);
    caseMesh.rotation.x = Math.PI / 2;
    caseMesh.position.z = -R * 0.15;
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(R * 1.02, R * 0.07, 14, 72), M.chrome);
    bezel.position.z = R * 0.02;
    const face = new THREE.Mesh(new THREE.CircleGeometry(R, 64), M.dialFace);
    face.position.z = 0.001;
    this.group.add(caseMesh, bezel, face, this.face);

    const steps = o.max / o.labelStep;
    const minorCount = steps * o.minor + 1;
    this.face.add(ticks(steps + 1, R * 0.8, R * 0.95, R * 0.035, R * 0.02, START, END, M.white));
    this.face.add(ticks(minorCount, R * 0.88, R * 0.95, R * 0.014, R * 0.015, START, END, M.white, (i) => i % o.minor === 0));

    if (o.redFrom !== undefined) {
      const a0 = this.toAngle(o.redFrom);
      const zone = new THREE.Mesh(new THREE.RingGeometry(R * 0.955, R * 0.995, 32, 1, END, a0 - END), M.red);
      zone.position.z = 0.006;
      this.face.add(zone);
    }

    const items: { text: string; x: number; y: number }[] = [];
    for (let k = 0; k <= steps; k += o.labelEvery ?? 1) {
      const a = this.toAngle(k * o.labelStep);
      items.push({ text: o.label(k * o.labelStep), x: Math.cos(a) * R * 0.64, y: Math.sin(a) * R * 0.64 });
    }
    const nums = new THREE.Mesh(labels(font, items, R * 0.15), M.white);
    nums.position.z = 0.004;
    this.face.add(nums);
    const title = new Text3D(font, M.white, { size: R * 0.1, depth: R * 0.01, bevel: 0 }, o.title);
    title.position.set(0, -R * 0.62, 0.004);
    this.face.add(title);

    // Needle: pointer + tail, pivoting on a chrome cap.
    const pointer = new THREE.Mesh(new THREE.BoxGeometry(R * 0.86, R * 0.035, R * 0.03), M.red);
    pointer.position.x = R * 0.36;
    const tail = new THREE.Mesh(new THREE.BoxGeometry(R * 0.22, R * 0.06, R * 0.03), M.red);
    tail.position.x = -R * 0.1;
    this.needle.add(pointer, tail);
    this.needle.position.z = R * 0.06;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.09, R * 0.09, R * 0.06, 24), M.chrome);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = R * 0.08;
    this.group.add(this.needle, cap);

    const glass = new THREE.Mesh(new THREE.CircleGeometry(R * 1.0, 48), M.glass);
    glass.position.z = R * 0.13;
    glass.renderOrder = 10;
    this.group.add(glass);
  }

  toAngle(v: number) {
    const t = Math.max(0, Math.min(1.02, v / this.o.max));
    return START + (END - START) * t;
  }

  /** Sprung needle: overshoots a touch, like a real gauge. */
  update(dt: number, value: number) {
    const target = this.toAngle(value);
    this.vel += ((target - this.angle) * 260 - this.vel * 26) * dt;
    this.angle += this.vel * dt;
    this.needle.rotation.z = this.angle;
  }
}

/** Speedometer with a little LED km/h readout. */
export class Speedometer extends Dial {
  private readout: SevenSegment;
  constructor(font: Font, M: HudMaterials, radius: number) {
    super(font, M, {
      radius, max: 240, labelStep: 20, minor: 4, labelEvery: 2, label: (v) => String(v), title: 'KM/H',
    });
    this.readout = new SevenSegment('888', radius * 0.17, new THREE.Color('#ff7a1a'), new THREE.Color('#2a130a'), M.led);
    this.readout.mesh.position.set(0, -radius * 0.38, 0.01);
    this.face.add(this.readout.mesh);
  }
  set(dt: number, kmh: number) {
    this.update(dt, kmh);
    this.readout.set(String(Math.round(kmh)).padStart(3, ' '));
  }
}

/** Rev counter with a gear readout, AUTO/MAN tag and a shift light. */
export class Tachometer extends Dial {
  private gear: SevenSegment;
  private mode: Text3D;
  private shiftLight: THREE.Mesh;
  private lightOn = new THREE.MeshBasicMaterial({ color: '#ff3b1f', toneMapped: false });
  private lightOff: THREE.Material;
  private flash = 0;

  constructor(font: Font, M: HudMaterials, radius: number, redline: number) {
    super(font, M, {
      radius, max: 8000, labelStep: 1000, minor: 5, label: (v) => String(v / 1000), title: 'RPM x1000', redFrom: redline,
    });
    this.gear = new SevenSegment('8', radius * 0.34, new THREE.Color('#3dff8a'), new THREE.Color('#0b2414'), M.led);
    this.gear.mesh.position.set(0, -radius * 0.32, 0.01);
    this.face.add(this.gear.mesh);
    this.mode = new Text3D(font, M.white, { size: radius * 0.085, depth: radius * 0.01, bevel: 0 }, 'AUTO');
    this.mode.position.set(0, radius * 0.25, 0.004);
    this.face.add(this.mode);
    this.lightOff = M.gunmetal;
    this.shiftLight = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.08, 16, 12), this.lightOff);
    this.shiftLight.position.set(0, radius * 1.18, 0);
    this.group.add(this.shiftLight);
  }

  set(dt: number, rpm: number, gear: number, auto: boolean, shiftAt: number) {
    this.update(dt, rpm);
    this.gear.set(gear < 0 ? 'r' : String(gear));
    this.mode.set(auto ? 'AUTO' : 'MANUAL');
    // Shift light: steady near the shift point, flashing on the limiter.
    this.flash += dt * 18;
    const on = rpm > shiftAt && (rpm < shiftAt + 450 || Math.sin(this.flash) > 0);
    this.shiftLight.material = on ? this.lightOn : this.lightOff;
  }
}

/**
 * Chrome stopwatch: crown and pushers, an analog seconds hand and minutes
 * subdial, plus an LCD lap timer.
 */
export class Stopwatch {
  readonly group = new THREE.Group();
  private seconds = new THREE.Group();
  private minutes = new THREE.Group();
  private lcd: SevenSegment;
  private crown = new THREE.Group();
  private press = 0;

  constructor(font: Font, M: HudMaterials, R: number) {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.04, R * 1.04, R * 0.34, 56), M.chrome);
    body.rotation.x = Math.PI / 2;
    body.position.z = -R * 0.17;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R * 1.0, R * 0.075, 14, 72), M.chrome);
    rim.position.z = R * 0.02;
    const face = new THREE.Mesh(new THREE.CircleGeometry(R, 64), M.ivory);
    face.position.z = 0.001;
    this.group.add(body, rim, face);

    // Crown, loop and pushers on top.
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.08, R * 0.08, R * 0.18, 16), M.chrome);
    stem.position.y = R * 1.12;
    const knob = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.16, R * 0.16, R * 0.14, 24), M.chrome);
    knob.position.y = R * 1.26;
    const loop = new THREE.Mesh(new THREE.TorusGeometry(R * 0.16, R * 0.035, 10, 32), M.chrome);
    loop.position.y = R * 1.48;
    this.crown.add(stem, knob, loop);
    this.crown.position.z = -R * 0.12;
    this.group.add(this.crown);
    for (const side of [-1, 1]) {
      const a = Math.PI / 2 + side * 0.75;
      const pusher = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.07, R * 0.07, R * 0.2, 14), M.chrome);
      pusher.position.set(Math.cos(a) * R * 1.12, Math.sin(a) * R * 1.12, -R * 0.12);
      pusher.rotation.z = a - Math.PI / 2;
      this.group.add(pusher);
    }

    // Dial: 60 ticks (every 5th long), numerals every 5 seconds.
    const T0 = Math.PI / 2, T1 = Math.PI / 2 - Math.PI * 2 * (59 / 60);
    this.group.add(ticks(60, R * 0.86, R * 0.96, R * 0.012, R * 0.01, T0, T1, M.ink, (i) => i % 5 === 0));
    this.group.add(ticks(12, R * 0.8, R * 0.96, R * 0.03, R * 0.012, T0, Math.PI / 2 - Math.PI * 2 * (11 / 12), M.ink));
    const items: { text: string; x: number; y: number }[] = [];
    for (let k = 1; k <= 12; k++) {
      const a = Math.PI / 2 - (k / 12) * Math.PI * 2;
      items.push({ text: String(k * 5), x: Math.cos(a) * R * 0.66, y: Math.sin(a) * R * 0.66 });
    }
    const nums = new THREE.Mesh(labels(font, items, R * 0.13), M.ink);
    nums.position.z = 0.004;
    this.group.add(nums);

    // Minutes subdial (30 min).
    const sub = new THREE.Group();
    sub.position.set(0, R * 0.34, 0.004);
    const subRing = new THREE.Mesh(new THREE.RingGeometry(R * 0.2, R * 0.215, 40), M.ink);
    sub.add(subRing, ticks(6, R * 0.16, R * 0.2, R * 0.012, R * 0.008, Math.PI / 2, Math.PI / 2 - Math.PI * 2 * (5 / 6), M.ink));
    const mh = new THREE.Mesh(new THREE.BoxGeometry(R * 0.02, R * 0.17, R * 0.02), M.ink);
    mh.position.y = R * 0.075;
    this.minutes.add(mh);
    this.minutes.position.z = 0.01;
    sub.add(this.minutes);
    this.group.add(sub);

    // LCD lap timer.
    const ly = -R * 0.27;
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(R * 0.86, R * 0.3, R * 0.04), M.gunmetal);
    bezel.position.set(0, ly, 0.01);
    const screen = new THREE.Mesh(new THREE.BoxGeometry(R * 0.79, R * 0.23, R * 0.04), M.lcd);
    screen.position.set(0, ly, 0.02);
    this.lcd = new SevenSegment('8:88.88', R * 0.14, new THREE.Color('#141a12'), new THREE.Color('#9aa890'), M.lcdSeg);
    this.lcd.mesh.position.set(0, ly, R * 0.045);
    this.group.add(bezel, screen, this.lcd.mesh);

    // Seconds hand.
    const hand = new THREE.Mesh(new THREE.BoxGeometry(R * 0.022, R * 1.08, R * 0.02), M.red);
    hand.position.y = R * 0.34;
    this.seconds.add(hand);
    this.seconds.position.z = R * 0.06;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.06, R * 0.06, R * 0.05, 20), M.red);
    cap.rotation.x = Math.PI / 2;
    cap.position.z = R * 0.07;
    this.group.add(this.seconds, cap);

    const glass = new THREE.Mesh(new THREE.CircleGeometry(R, 48), M.glass);
    glass.position.z = R * 0.12;
    glass.renderOrder = 10;
    this.group.add(glass);
  }

  /** Animate the crown being pressed (a new lap). */
  click() {
    this.press = 1;
  }

  set(dt: number, t: number | null) {
    const time = t ?? 0;
    this.seconds.rotation.z = -((time % 60) / 60) * Math.PI * 2;
    this.minutes.rotation.z = -((time / 60) % 30 / 30) * Math.PI * 2;
    const m = Math.min(9, Math.floor(time / 60));
    const s = time - m * 60;
    this.lcd.set(`${m}:${s.toFixed(2).padStart(5, '0')}`);
    this.press = Math.max(0, this.press - dt * 4);
    this.crown.position.y = -Math.sin(this.press * Math.PI) * 0.06;
  }
}

