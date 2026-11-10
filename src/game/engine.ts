import * as THREE from 'three';
import { getSharedMaterial, type ModelLibrary } from './assets';
import { CAMERA_MODES, ChaseCamera, CinematicCamera } from './camera';
import { Car, type CarEnv, type Controls, type DetachEvent } from './car';
import { StaticWorld } from './collision';
import { DebrisSystem, type Debris } from './debris';
import { Input } from './input';
import { buildLayout, type Layout } from './layout';
import { clamp, yawFromDir } from './math';
import { PropSystem } from './props';
import { makeMountains, makeSky, SKY_HORIZON, SUN_DIR } from './sky';
import { Sparks } from './sparks';
import { Terrain } from './terrain';
import { formatTime } from './format';
import { Hud3D } from './hud/hud3d';
import type { Font } from './hud/text';
import { buildTrackMeshes, HALF_WIDTH, Track } from './track';

const STEP = 1 / 120;
const COAST: Controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };

// ---- Slow-mo crash cam ------------------------------------------------------
/** Real seconds the shot lasts. */
const SLOWMO_LENGTH = 2.4;
/** Time scale at the slowest. */
const SLOWMO_SCALE = 0.12;
/** Real seconds after a shot before another can start. */
const SLOWMO_COOLDOWN = 3.5;
/** A detach triggers the shot if the hit was this hard (m/s) or the part this heavy (kg). */
const SLOWMO_MIN_SEVERITY = 9;
const SLOWMO_MIN_MASS = 8;

/** 'manual' = the owner's manual is open before the first countdown. */
type RaceState = 'manual' | 'countdown' | 'racing';

export class Engine {
  readonly input = new Input();
  readonly track = new Track();
  readonly terrain: Terrain;
  readonly world = new StaticWorld();
  readonly props: PropSystem;
  readonly layout: Layout;
  readonly car: Car;
  readonly debris: DebrisSystem;
  readonly sparks: Sparks;
  readonly chase: ChaseCamera;
  readonly cine: CinematicCamera;
  private sun: THREE.DirectionalLight;
  private sky: ReturnType<typeof makeSky>;
  private root = new THREE.Group();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private startLights?: THREE.MeshStandardMaterial;
  private ground: (x: number, z: number) => number;
  readonly hud: Hud3D;
  /** The manual is open (game paused). */
  private paused = true;
  private hudSize = new THREE.Vector2();

  private trackIdx = -1;
  private onRoad = true;
  private accumulator = 0;
  /** Game time (slowed during slow-mo), used for lap times. */
  private time = 0;
  private realTime = 0;
  private race = {
    state: 'manual' as RaceState,
    countdown: 3.5,
    lap: 0,
    lapStart: 0,
    lastLap: null as number | null,
    bestLap: null as number | null,
    cp1: false,
    cp2: false,
    wrongWayTime: 0,
  };
  private slowmo = {
    enabled: true,
    active: false,
    t: 0,
    cooldown: 0,
    target: null as Debris | null,
  };
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 60;
  private scrape = Array.from({ length: 4 }, () => new THREE.Vector3());
  private env: CarEnv;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    readonly renderer: THREE.WebGLRenderer,
    carLib: ModelLibrary,
    propLib: ModelLibrary,
    font: Font,
    debug = false,
  ) {
    this.root.name = 'hatchback-hell';
    scene.add(this.root);

    // ---- Landscape ---------------------------------------------------------
    // The terrain also sets the track's elevation, so it comes before anything placed on it.
    this.terrain = new Terrain(this.track);
    const terrain = this.terrain;
    this.ground = (x, z) => terrain.height(x, z);
    this.root.add(terrain.mesh);
    this.root.add(makeMountains(terrain.centre.x, terrain.centre.y));

    // ---- Sky, fog, lights --------------------------------------------------
    this.sky = makeSky();
    this.root.add(this.sky.mesh);
    scene.fog = new THREE.Fog(SKY_HORIZON.clone(), 170, 820);
    scene.background = SKY_HORIZON.clone();
    // Reflections come from the same sky (without clouds), baked once.
    {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(makeSky(false).mesh);
      envScene.add(
        new THREE.Mesh(
          new THREE.CircleGeometry(400, 16).rotateX(-Math.PI / 2).translate(0, -2, 0),
          new THREE.MeshBasicMaterial({ color: '#4c7a3a' }),
        ),
      );
      this.envTarget = pmrem.fromScene(envScene, 0.02);
      scene.environment = this.envTarget.texture;
      scene.environmentIntensity = 0.7;
      pmrem.dispose();
    }

    this.root.add(new THREE.HemisphereLight('#cfe6ff', '#4a6b3a', 1.05));
    this.sun = new THREE.DirectionalLight('#ffeccc', 2.8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -45;
    sc.right = sc.top = 45;
    sc.near = 10;
    sc.far = 300;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.root.add(this.sun, this.sun.target);

    // ---- Track, props, car -------------------------------------------------
    this.root.add(buildTrackMeshes(this.track));
    this.props = new PropSystem(propLib, this.ground);
    this.layout = buildLayout(this.track, this.props, this.world, terrain);
    this.props.build();
    this.root.add(this.props.group);
    this.startLights = getSharedMaterial('neon #b00a0a') as THREE.MeshStandardMaterial | undefined;

    this.car = new Car(carLib, this.ground);
    this.root.add(this.car.root);
    this.debris = new DebrisSystem(scene, this.ground);
    this.sparks = new Sparks(this.ground);
    this.root.add(this.sparks.points);
    this.chase = new ChaseCamera(camera, this.ground);
    this.cine = new CinematicCamera(camera, this.ground);

    this.env = {
      world: this.world,
      ramps: this.layout.ramps,
      onRoad: true,
      pushables: [this.props.dynamic.map((d) => ({ body: d.body, hardness: d.spec.hardness })), this.debris.items],
      onImpact: (x, y, z, sev) => {
        this.sparks.emit(x, y, z, Math.min(Math.round(sev * 2), 40), 2 + sev * 0.25, this.car.vx, this.car.vz);
        this.chase.addShake(Math.min(sev / 25, 0.8));
      },
    };

    this.hud = new Hud3D(font, scene.environment, this.track, terrain, carLib, debug);
    this.restart();
    this.race.state = 'manual';
  }

  restart() {
    const i = this.layout.gridIndex;
    const t = this.track;
    this.endSlowmo();
    this.car.place(t.px[i], t.pz[i], yawFromDir(t.tx[i], t.tz[i]), true);
    this.debris.clear();
    this.props.reset();
    this.trackIdx = -1;
    Object.assign(this.race, {
      state: 'countdown', countdown: 3.5, lap: 0, lapStart: 0, cp1: false, cp2: false, wrongWayTime: 0,
    });
    this.chase.snap();
    this.hud.setBanner(null);
  }

  /** Put the car back on the racing line where it is, without repairing it. */
  recover() {
    const t = this.track;
    const i = t.nearest(this.car.x, this.car.z);
    this.endSlowmo();
    this.car.place(t.px[i], t.pz[i], yawFromDir(t.tx[i], t.tz[i]), false);
    this.trackIdx = i;
    this.chase.snap();
  }

  update(frameDt: number) {
    const realDt = Math.min(frameDt, 1 / 20);
    this.realTime += realDt;
    const input = this.input;
    input.update(realDt);
    // The manual: H toggles it (pausing the game); Enter/Escape close it.
    const book = this.hud.manual;
    if (input.pressed('KeyH')) this.setManual(!book.isOpen);
    if (book.isOpen && (input.pressed('Enter') || input.pressed('Escape'))) this.setManual(false);
    if (input.pressed('Enter') || input.pressed('Backspace')) this.restart();
    if (input.pressed('KeyR')) this.recover();
    if (input.pressed('KeyT')) {
      this.car.autoGearbox = !this.car.autoGearbox;
      this.hud.toast(`Gearbox: ${this.car.autoGearbox ? 'automatic' : 'manual'}`, 'info');
    }
    if (!this.paused && this.race.state === 'racing') {
      if (input.pressed('KeyE')) this.car.shift(1);
      if (input.pressed('KeyQ')) this.car.shift(-1);
    }
    if (input.pressed('KeyC')) {
      this.chase.cycle();
      this.hud.toast(`Camera: ${CAMERA_MODES[this.chase.mode]}`, 'info');
    }
    if (input.pressed('KeyM')) {
      this.slowmo.enabled = !this.slowmo.enabled;
      if (!this.slowmo.enabled) this.endSlowmo();
      this.hud.toast(`Crash cam ${this.slowmo.enabled ? 'on' : 'off'}`, 'info');
    }

    // ---- Time scale ------------------------------------------------------
    const sm = this.slowmo;
    sm.cooldown -= realDt;
    let scale = 1;
    if (sm.active) {
      sm.t += realDt;
      const easeIn = clamp(sm.t / 0.12, 0, 1);
      const easeOut = clamp((SLOWMO_LENGTH - sm.t) / 0.6, 0, 1);
      scale = 1 + (SLOWMO_SCALE - 1) * Math.min(easeIn, easeOut);
      if (sm.t >= SLOWMO_LENGTH || (sm.target && !this.debris.items.includes(sm.target))) this.endSlowmo();
    }
    if (this.paused) scale = 0;
    const dt = realDt * scale;
    this.time += dt;

    if (!this.paused) this.updateCountdown(realDt);
    // On the grid (or paused) the engine still revs.
    if (this.race.state !== 'racing') this.car.idleRev(realDt, this.paused ? 0 : input.throttle);
    const racing = this.race.state === 'racing';
    const controls: Controls | null = !racing ? null : sm.active ? COAST : input;

    // ---- Fixed-step simulation ------------------------------------------
    this.accumulator += dt;
    const prevIdx = this.trackIdx;
    while (this.accumulator >= STEP) {
      this.accumulator -= STEP;
      this.trackIdx = this.track.nearest(this.car.x, this.car.z, this.trackIdx);
      // The kerbs count as road.
      this.onRoad = Math.abs(this.track.lateral(this.trackIdx, this.car.x, this.car.z)) < HALF_WIDTH + 1.2;
      this.env.onRoad = this.onRoad;
      this.car.step(STEP, controls, this.env);
      this.props.update(STEP, this.world);
      this.debris.update(STEP, this.world);
    }

    const detached = this.car.drainDetached();
    let star: { ev: DetachEvent; debris: Debris } | null = null;
    for (const ev of detached) {
      const d = this.debris.spawn(this.car, ev);
      this.hud.toast(`${ev.part.name.replace(/_/g, ' ')} gone!`, 'loss');
      this.chase.addShake(0.25);
      if (!star || ev.part.mass > star.ev.part.mass) star = { ev, debris: d };
    }
    if (star && racing && sm.enabled && !sm.active && sm.cooldown <= 0) {
      const big = star.ev.severity >= SLOWMO_MIN_SEVERITY || star.ev.part.mass >= SLOWMO_MIN_MASS;
      if (big) this.startSlowmo(star.debris, star.ev);
    }

    // Sparks from corners dragging on the tarmac.
    const speed = Math.abs(this.car.speed);
    if (speed > 2) {
      const n = this.car.scrapePoints(this.scrape);
      for (let k = 0; k < n; k++) {
        if (Math.random() < Math.min(speed / 15, 1) * scale) {
          const p = this.scrape[k];
          this.sparks.emit(p.x, p.y, p.z, 2, 1.5 + speed * 0.05, this.car.vx, this.car.vz);
        }
      }
    }
    this.sparks.update(dt);

    this.car.syncVisual(dt);
    this.debris.syncVisual();
    if (sm.active && sm.target) this.cine.update(realDt, sm.target.body.pos, this.car);
    else this.chase.update(realDt, this.car);
    this.sky.mesh.position.copy(this.camera.position);
    this.sky.material.uniforms.time.value = this.realTime;

    // Shadow frustum follows the car, snapped to texels to avoid shimmering.
    const focus = sm.active && sm.target ? sm.target.body.pos : null;
    const fx = focus ? focus.x : this.car.x, fz = focus ? focus.z : this.car.z;
    const texel = 90 / 2048;
    const tx = Math.round(fx / texel) * texel;
    const tz = Math.round(fz / texel) * texel;
    const ty = this.ground(tx, tz);
    this.sun.target.position.set(tx, ty, tz);
    this.sun.position.set(tx + SUN_DIR.x * 150, ty + SUN_DIR.y * 150, tz + SUN_DIR.z * 150);

    if (racing) this.updateLaps(prevIdx, dt);
    this.updateHud(realDt);
  }

  private setManual(open: boolean) {
    this.hud.manual.setOpen(open);
    this.paused = open;
    if (open) this.endSlowmo();
    // Closing the manual before the first race starts the countdown.
    else if (this.race.state === 'manual') this.race.state = 'countdown';
  }

  /** Draw the game, then the 3D HUD over it. */
  render() {
    const r = this.renderer;
    r.getSize(this.hudSize);
    this.hud.resize(this.hudSize.x, this.hudSize.y);
    r.autoClear = true;
    r.render(this.scene, this.camera);
    r.autoClear = false;
    r.clearDepth();
    this.hud.render(r);
    r.autoClear = true;
  }

  private startSlowmo(target: Debris, ev: DetachEvent) {
    const sm = this.slowmo;
    sm.active = true;
    sm.t = 0;
    sm.target = target;
    this.cine.start(target.body.pos, this.car);
    this.hud.cinematic(ev.part.name.replace(/_/g, ' '));
  }

  private endSlowmo() {
    const sm = this.slowmo;
    if (!sm.active) return;
    sm.active = false;
    sm.target = null;
    sm.cooldown = SLOWMO_COOLDOWN;
    // Hand back to the chase cam from where the crash cam is, so it glides home.
    this.chase.resumeFrom(this.camera.position, this.cine.look, this.car);
    this.hud.cinematic(null);
  }

  private updateCountdown(dt: number) {
    const r = this.race;
    if (r.state !== 'countdown') return;
    const before = Math.ceil(r.countdown - 0.5);
    r.countdown -= dt;
    const after = Math.ceil(r.countdown - 0.5);
    const lights = this.startLights;
    if (lights) lights.emissiveIntensity = r.countdown > 0.5 ? 3 : 0;
    if (after !== before || r.countdown > 3.4) this.hud.setBanner(after > 0 ? String(after) : null);
    if (r.countdown <= 0.5) {
      r.state = 'racing';
      this.hud.setBanner('GO!');
      setTimeout(() => this.hud.setBanner(null), 700);
    }
  }

  private updateLaps(prevIdx: number, dt: number) {
    const r = this.race;
    const n = this.track.n;
    const i = this.trackIdx;
    if (prevIdx < 0) return;
    if (i > n / 3 && i < n / 3 + 30 && r.lap > 0) r.cp1 = true;
    if (i > (2 * n) / 3 && i < (2 * n) / 3 + 30 && r.cp1) r.cp2 = true;

    const forward = prevIdx > n * 0.75 && i < n * 0.25;
    const backward = prevIdx < n * 0.25 && i > n * 0.75;
    if (forward) {
      if (r.lap === 0) {
        r.lap = 1;
        r.lapStart = this.time;
      } else if (r.cp1 && r.cp2) {
        const lapTime = this.time - r.lapStart;
        r.lastLap = lapTime;
        const best = r.bestLap === null || lapTime < r.bestLap;
        if (best) r.bestLap = lapTime;
        this.hud.toast(`Lap ${r.lap}  ${formatTime(lapTime)}${best ? '  - best!' : ''}`, 'lap');
        r.lap++;
        r.lapStart = this.time;
      }
      r.cp1 = r.cp2 = false;
    } else if (backward) {
      r.cp1 = r.cp2 = false;
    }

    // Wrong way: moving against the track direction for a while.
    const t = this.track;
    const along = this.car.vx * t.tx[i] + this.car.vz * t.tz[i];
    r.wrongWayTime = along < -3 ? r.wrongWayTime + dt : 0;
  }

  private updateHud(dt: number) {
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    const r = this.race;
    const c = this.car;
    this.hud.update(
      dt,
      {
        speedKmh: Math.abs(c.speed) * 3.6,
        rpm: c.rpm,
        gear: c.gear,
        autoGearbox: c.autoGearbox,
        lap: r.lap,
        lapTime: r.lap > 0 ? this.time - r.lapStart : null,
        lastLap: r.lastLap,
        bestLap: r.bestLap,
        wrongWay: r.wrongWayTime > 1.2,
        fps: this.fps,
      },
      c,
    );
  }

  dispose() {
    this.input.dispose();
    this.scene.remove(this.root);
    this.debris.clear();
    this.scene.environment = null;
    this.scene.fog = null;
    this.scene.background = null;
    this.envTarget?.dispose();
  }
}

export { formatTime };
