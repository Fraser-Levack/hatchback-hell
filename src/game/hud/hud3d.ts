import * as THREE from 'three';
import type { ModelLibrary } from '../assets';
import type { Car } from '../car';
import { REDLINE_RPM } from '../car';
import { formatTime } from '../format';
import type { Terrain } from '../terrain';
import type { Track } from '../track';
import { DamageModel } from './damage';
import { Speedometer, Stopwatch, Tachometer } from './gauges';
import { ManualBook } from './manual';
import { createHudMaterials, type HudMaterials } from './materials';
import { TopoMap } from './minimap';
import { Text3D, textGeometry, type Font } from './text';

export interface HudFrame {
  speedKmh: number;
  rpm: number;
  gear: number;
  autoGearbox: boolean;
  lap: number;
  lapTime: number | null;
  lastLap: number | null;
  bestLap: number | null;
  wrongWay: boolean;
  fps: number;
}

export type ToastKind = 'loss' | 'lap' | 'info';

interface Toast {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  age: number;
  y: number;
}

const FOV = 30;
const DIST = 20;
/** Visible height of the HUD plane at z = 0, in HUD units. */
const VIEW_H = 2 * DIST * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const TOAST_LIFE = 2.4;

/**
 * The whole HUD as a second 3D scene, rendered over the game with its own
 * camera and lights: analog gauges, a stopwatch, a topographic map, a damage
 * model, the owner's manual, and 3D text for everything else.
 */
export class Hud3D {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1, 60);
  private M: HudMaterials;
  /** Everything hidden during the slow-mo replay. */
  private main = new THREE.Group();
  private speedo: Speedometer;
  private tacho: Tachometer;
  private stopwatch: Stopwatch;
  private lapText: Text3D;
  private splits: Text3D;
  private map: TopoMap;
  private damage: DamageModel;
  readonly manual: ManualBook;
  private manualHint: Text3D;
  private banner = new THREE.Group();
  private bannerText: Text3D;
  private bannerAge = 0;
  private wrongWay = new THREE.Group();
  private wrongPulse = 0;
  private toasts: Toast[] = [];
  private toastMats: Record<ToastKind, THREE.MeshStandardMaterial>;
  private bars: THREE.Mesh[] = [];
  private barsT = 0;
  private barsTarget = 0;
  private cineTag: Text3D;
  private cineCaption: Text3D;
  private cineBlink = 0;
  private vignette: THREE.Mesh;
  private vignetteMat: THREE.ShaderMaterial;
  private fpsText: Text3D;
  private lastLapCount = 0;
  private viewW = VIEW_H;
  private size = new THREE.Vector2();
  private U = VIEW_H / 10;

  constructor(
    private font: Font,
    env: THREE.Texture | null,
    track: Track,
    terrain: Terrain,
    carLib: ModelLibrary,
    private debug: boolean,
  ) {
    const M = (this.M = createHudMaterials());
    const U = this.U;
    this.camera.position.set(0, 0, DIST);
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.9;
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#3a3f48', 1.6));
    const key = new THREE.DirectionalLight('#fff4e0', 2.2);
    key.position.set(-6, 8, 10);
    this.scene.add(key);
    this.scene.add(this.main);

    // Gauges.
    this.speedo = new Speedometer(font, M, U * 1.3);
    this.tacho = new Tachometer(font, M, U * 1.0, REDLINE_RPM);
    this.stopwatch = new Stopwatch(font, M, U * 0.95);
    this.lapText = new Text3D(font, M.yellow, { size: U * 0.32, align: 'left' }, 'LAP -');
    this.splits = new Text3D(font, M.white, { size: U * 0.16, depth: U * 0.02, bevel: 0, align: 'left' }, '');
    // Dark plaque behind the splits so they read against bright sky.
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(U * 2.55, U * 0.3, U * 0.04), M.gunmetal);
    plaque.position.set(U * 1.22, 0, -U * 0.04);
    this.splits.add(plaque);
    this.main.add(this.speedo.group, this.tacho.group, this.stopwatch.group, this.lapText, this.splits);

    this.map = new TopoMap(track, terrain, M, U * 3.4);
    this.damage = new DamageModel(carLib, font, M, U * 2.0);
    this.main.add(this.map.group, this.damage.group);

    this.manual = new ManualBook(U * 6.4);
    this.manualHint = new Text3D(font, M.white, { size: U * 0.13, depth: U * 0.015, bevel: 0 }, 'H  MANUAL');
    this.scene.add(this.manual.backdrop, this.manual.group);
    this.main.add(this.manualHint);

    // Centre-screen banner (countdown, GO!) and the wrong-way sign.
    this.bannerText = new Text3D(font, M.white, { size: U * 1.6, depth: U * 0.4, bevel: U * 0.05 }, '');
    this.banner.add(this.bannerText);
    this.banner.visible = false;
    this.scene.add(this.banner);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(U * 4.6, U * 0.9, U * 0.12), M.red);
    plate.position.z = -U * 0.1;
    const ww = new Text3D(font, M.white, { size: U * 0.5, depth: U * 0.12 }, 'WRONG WAY');
    this.wrongWay.add(plate, ww);
    this.wrongWay.visible = false;
    this.scene.add(this.wrongWay);

    this.toastMats = {
      loss: new THREE.MeshStandardMaterial({ color: '#ff4b3a', emissive: '#c8161d', emissiveIntensity: 0.6, transparent: true }),
      lap: new THREE.MeshStandardMaterial({ color: '#ffcf33', emissive: '#ffb000', emissiveIntensity: 0.5, transparent: true }),
      info: new THREE.MeshStandardMaterial({ color: '#f4f4f2', emissive: '#ffffff', emissiveIntensity: 0.2, transparent: true }),
    };

    // Slow-mo letterbox.
    for (let k = 0; k < 2; k++) {
      const bar = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), M.black);
      bar.renderOrder = 20;
      this.bars.push(bar);
      this.scene.add(bar);
    }
    this.cineTag = new Text3D(font, M.red, { size: U * 0.16, depth: U * 0.02, bevel: 0 }, '>>  SLOW-MO REPLAY  <<');
    this.cineCaption = new Text3D(font, M.white, { size: U * 0.42, depth: U * 0.06 }, '');
    for (const t of [this.cineTag, this.cineCaption]) {
      t.renderOrder = 21;
      this.scene.add(t);
    }

    // Speed vignette over the game (but under the HUD).
    this.vignetteMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { strength: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform float strength; varying vec2 vUv; void main(){ vec2 d = vUv - 0.5; float r = length(d * vec2(1.4, 1.0)); gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(0.35, 0.85, r) * strength); }',
    });
    this.vignette = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.vignetteMat);
    this.vignette.renderOrder = -10;
    this.vignette.position.z = -2;
    this.scene.add(this.vignette);

    this.fpsText = new Text3D(font, M.white, { size: U * 0.1, depth: U * 0.01, bevel: 0, align: 'right' }, '');
    this.fpsText.visible = debug;
    this.scene.add(this.fpsText);

    // Pre-build the strings that pop up mid-race so they don't hitch the frame.
    for (const s of ['3', '2', '1', 'GO!']) textGeometry(font, s, { size: U * 1.6, depth: U * 0.4, bevel: U * 0.05 });
    this.resize(16, 9);
  }

  /** Lay everything out for a viewport of w x h pixels. */
  resize(w: number, h: number) {
    if (w === this.size.x && h === this.size.y) return;
    this.size.set(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const H = VIEW_H, W = H * aspect, U = this.U;
    this.viewW = W;
    // Shrink everything a bit on narrow screens.
    const s = Math.min(1, aspect / 1.5);
    const L = -W / 2, R = W / 2, T = H / 2, B = -H / 2;
    const at = (o: THREE.Object3D, x: number, y: number, z = 0) => {
      o.position.set(x, y, z);
      o.scale.setScalar(s);
    };
    // Bottom right: rev counter + speedometer cluster.
    at(this.speedo.group, R - U * 1.75 * s, B + U * 1.75 * s);
    at(this.tacho.group, R - U * 4.2 * s, B + U * 1.35 * s);
    this.speedo.group.rotation.set(0.12, -0.22, 0);
    this.tacho.group.rotation.set(0.12, -0.12, 0);
    // Top left: stopwatch, lap and splits.
    at(this.stopwatch.group, L + U * 1.45 * s, T - U * 1.65 * s);
    this.stopwatch.group.rotation.set(-0.1, 0.22, 0.05);
    at(this.lapText, L + U * 2.75 * s, T - U * 1.05 * s);
    at(this.splits, L + U * 2.78 * s, T - U * 1.55 * s);
    // Top right: map.
    at(this.map.group, R - U * 2.1 * s, T - U * 1.85 * s);
    this.map.group.rotation.set(0, -0.15, 0);
    // Bottom left: damage model.
    at(this.damage.group, L + U * 1.6 * s, B + U * 1.75 * s);
    at(this.manualHint, L + U * 3.95 * s, B + U * 0.3 * s);
    // Manual: open in the middle, closed in the bottom-left gap.
    this.manual.layout(
      new THREE.Vector3(0, -U * 0.1, 2),
      new THREE.Vector3(L + U * 3.95 * s, B + U * 0.95 * s, 0),
      0.14 * s,
      W * 1.2,
      H * 1.2,
    );
    this.banner.position.set(0, U * 1.2, 0);
    this.wrongWay.position.set(0, U * 0.2, 0);
    this.wrongWay.scale.setScalar(s);
    this.vignette.scale.set(W * 1.2, H * 1.2, 1);
    for (const bar of this.bars) bar.scale.set(W * 1.2, H * 0.12, 1);
    this.fpsText.position.set(R - U * 0.15, T - U * 0.12, 0);
    this.layoutBars();
  }

  private layoutBars() {
    const H = VIEW_H;
    const e = this.barsT * this.barsT * (3 - 2 * this.barsT);
    const bh = H * 0.12;
    this.bars[0].position.set(0, H / 2 + bh / 2 - bh * e, 0.3);
    this.bars[1].position.set(0, -H / 2 - bh / 2 + bh * e, 0.3);
    this.cineTag.position.set(0, this.bars[0].position.y, 0.35);
    this.cineCaption.position.set(0, this.bars[1].position.y, 0.35);
    const shown = e > 0.01;
    for (const b of this.bars) b.visible = shown;
    this.cineCaption.visible = shown;
    this.cineTag.visible = shown && Math.sin(this.cineBlink) > -0.3;
  }

  update(dt: number, f: HudFrame, car: Car) {
    this.speedo.set(dt, f.speedKmh);
    this.tacho.set(dt, f.rpm, f.gear, f.autoGearbox, 6800);
    this.stopwatch.set(dt, f.lapTime);
    if (f.lap !== this.lastLapCount) {
      if (f.lap > 1) this.stopwatch.click();
      this.lastLapCount = f.lap;
    }
    this.lapText.set(f.lap > 0 ? `LAP ${f.lap}` : 'LAP -');
    this.splits.set(`LAST ${f.lastLap === null ? '-:--.--' : formatTime(f.lastLap)}   BEST ${f.bestLap === null ? '-:--.--' : formatTime(f.bestLap)}`);
    this.map.update(dt, car.x, car.z, car.heading);
    this.damage.update(dt, car);
    this.manual.update(dt);

    // Banner pop.
    if (this.banner.visible) {
      this.bannerAge += dt;
      const t = Math.min(this.bannerAge / 0.35, 1);
      const pop = 1 + 0.6 * Math.exp(-t * 5) * Math.cos(t * 9);
      this.banner.scale.setScalar(pop);
      this.banner.rotation.y = Math.sin(this.bannerAge * 2) * 0.25;
    }

    // Wrong way pulse.
    this.wrongWay.visible = f.wrongWay;
    if (f.wrongWay) {
      this.wrongPulse += dt * 6;
      this.wrongWay.rotation.z = Math.sin(this.wrongPulse) * 0.04;
    }

    // Toasts: pop in, stack, fade out.
    // Below the letterbox bar while a replay is rolling.
    const top = VIEW_H / 2 - this.U * 0.55 - this.barsT * VIEW_H * 0.12;
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.age += dt;
      if (t.age > TOAST_LIFE) {
        this.scene.remove(t.mesh);
        t.mat.dispose();
        this.toasts.splice(i, 1);
      }
    }
    this.toasts.forEach((t, i) => {
      const targetY = top - i * this.U * 0.42;
      t.y += (targetY - t.y) * Math.min(1, dt * 12);
      const inT = Math.min(t.age / 0.25, 1);
      const scale = 1 + 0.4 * Math.exp(-inT * 6) * Math.cos(inT * 8) - (1 - inT) * 0.9;
      t.mesh.position.set(0, t.y, 0.4);
      t.mesh.scale.setScalar(Math.max(scale, 0.01));
      t.mesh.rotation.x = (1 - inT) * 1.2;
      t.mat.opacity = Math.min(1, (TOAST_LIFE - t.age) / 0.5);
    });

    // Slow-mo bars.
    this.cineBlink += dt * 7;
    this.barsT += (this.barsTarget - this.barsT) * Math.min(1, dt * 7);
    this.layoutBars();
    this.main.visible = this.barsT < 0.5;
    // The closed book hides with the rest of the HUD during a replay.
    this.manual.group.visible = this.main.visible || this.manual.isOpen;
    this.vignetteMat.uniforms.strength.value = Math.max(0, Math.min(1, (f.speedKmh - 110) / 90)) * 0.75;
    if (this.debug) this.fpsText.set(`${Math.round(f.fps)} FPS`);
  }

  toast(text: string, kind: ToastKind = 'info') {
    const mat = this.toastMats[kind].clone();
    const mesh = new THREE.Mesh(textGeometry(this.font, text.toUpperCase(), { size: this.U * 0.26, depth: this.U * 0.06 }), mat);
    mesh.renderOrder = 15;
    this.scene.add(mesh);
    this.toasts.unshift({ mesh, mat, age: 0, y: VIEW_H / 2 + this.U * 0.4 });
    while (this.toasts.length > 6) {
      const old = this.toasts.pop()!;
      this.scene.remove(old.mesh);
      old.mat.dispose();
    }
  }

  setBanner(text: string | null) {
    if (text === null) {
      this.banner.visible = false;
      return;
    }
    this.bannerText.set(text);
    this.bannerText.material = text === 'GO!' ? this.M.green : this.M.white;
    this.banner.visible = true;
    this.bannerAge = 0;
  }

  cinematic(caption: string | null) {
    this.barsTarget = caption === null ? 0 : 1;
    if (caption) this.cineCaption.set(`${caption.toUpperCase()}  -  GONE`);
  }

  render(renderer: THREE.WebGLRenderer) {
    renderer.render(this.scene, this.camera);
  }
}
