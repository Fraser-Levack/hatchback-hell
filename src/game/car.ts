import * as THREE from 'three';
import { instantiate, UNIT, type ModelLibrary } from './assets';
import { circleVsCollider, rampHeight, type Collider, type Contact, type Ramp, type StaticWorld } from './collision';
import { clamp, damp } from './math';
import { GRAVITY, type GroundFn, type RigidBody } from './rigidbody';

// ---- Handling --------------------------------------------------------------
const WHEELBASE = 2.5;
const TRACK_WIDTH = 1.52;
const WHEEL_RADIUS = 0.31;
const MAX_STEER = 0.6;
const ENGINE = 21; // m/s^2 from standstill
// Where the drive force fades to zero. Drag holds the real top speed to ~190 km/h in 6th.
const TOP_SPEED = 64;
const REVERSE_TOP = 10;
const BRAKE = 30;
const ROLLING = 0.5;
const AIR_DRAG = 0.0011;
/** Lateral grip: how fast sideways sliding dies away. Lower = more sliding. */
const GRIP = { road: 6.5, grass: 2.6, handbrake: 1.1 };
/** Max cornering acceleration (m/s^2). */
const LAT_ACCEL = { road: 15, grass: 7 };
const MASS = 1000;
const INERTIA = 1700;
/** The car's collision shape: three circles along its length. */
const CIRCLES = [1.2, 0, -1.2];
const CIRCLE_R = 0.88;
const ROOF = 1.45;

// ---- Gearbox ---------------------------------------------------------------
/** Road speed (m/s) at the redline in each gear; index = gear. */
const GEAR_TOP = [0, 15, 24, 33, 42, 50, 58];
/** Extra pull in the low gears. */
const GEAR_PULL = [0, 1.25, 1.2, 1.12, 1.07, 1.03, 1.0];
export const IDLE_RPM = 900;
export const REDLINE_RPM = 7200;
export const LIMIT_RPM = 7600;
const UPSHIFT_RPM = 6950;
const DOWNSHIFT_RPM = 3300;
const SHIFT_TIME = 0.18;
/** Torque curve: 0.75 at idle, peaking ~1.1 mid-range, tailing off at the top. */
const torque = (rpm: number) => 0.75 + 0.35 * Math.sin(clamp((rpm - IDLE_RPM) / (LIMIT_RPM - IDLE_RPM), 0, 1) * Math.PI);

// ---- Damage ----------------------------------------------------------------
const HP: Record<string, number> = { panel: 75, bumper: 42, glass: 38, trim: 16, light: 16, wheel: 140 };
/** Damage starts to count above this impact speed (m/s). */
const DAMAGE_THRESHOLD = 1.5;
const DAMAGE_SCALE = 5;
/** How far damage spreads from the contact point (m^2, Gaussian). */
const DAMAGE_SPREAD = 2.3;
/** Parts that come off together with their parent. */
const CHILDREN: Record<string, string[]> = { bumper_front: ['plate_front'] };

export interface CarPart {
  name: string;
  category: string;
  detachable: boolean;
  mass: number;
  /** Car-local position of the part's pivot (m). */
  pivot: THREE.Vector3;
  /** Part-local bounds relative to the pivot (m). */
  box: THREE.Box3;
  group: THREE.Group;
  hp: number;
  maxHp: number;
  attached: boolean;
  hinge: THREE.Vector3;
  hingeAxis: THREE.Vector3;
  hangMax: number;
  wobble: number;
  wobbleVel: number;
  wheel: { front: boolean; left: boolean } | null;
}

export interface DetachEvent {
  part: CarPart;
  /** World-space push direction and how hard the hit was. */
  nx: number;
  nz: number;
  severity: number;
}

export interface Pushable {
  body: RigidBody;
  /** How much hitting it hurts, per m/s of the car's speed change. */
  hardness: number;
}

/** What the car is told to do this step. `Input` satisfies this. */
export interface Controls {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

export interface CarEnv {
  world: StaticWorld;
  ramps: Ramp[];
  onRoad: boolean;
  pushables: Pushable[][];
  /** Called for hard hits (world position, severity) — for sparks and camera shake. */
  onImpact(x: number, y: number, z: number, severity: number): void;
}

function hingeFor(name: string, b: THREE.Box3): { hinge: THREE.Vector3; axis: THREE.Vector3; max: number } {
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  switch (name) {
    case 'bonnet': return { hinge: v(b.min.x, b.max.y, 0), axis: Z, max: 0.55 };
    case 'door_right': return { hinge: v(b.max.x, 0, b.max.z), axis: Y, max: 0.75 };
    case 'door_left': return { hinge: v(b.max.x, 0, b.min.z), axis: Y, max: -0.75 };
    case 'tailgate': return { hinge: v(b.max.x, b.max.y, 0), axis: Z, max: -0.6 };
    case 'bumper_front': return { hinge: v(0, b.max.y, b.max.z), axis: X, max: -0.3 };
    case 'bumper_rear': return { hinge: v(0, b.max.y, b.min.z), axis: X, max: 0.3 };
    case 'mirror_right': return { hinge: v(0, 0, b.min.z), axis: Y, max: -1.1 };
    case 'mirror_left': return { hinge: v(0, 0, b.max.z), axis: Y, max: 1.1 };
    case 'plate_front':
    case 'plate_rear': return { hinge: v(0, b.max.y, b.max.z), axis: X, max: -0.8 };
    case 'spoiler': return { hinge: v(b.max.x, b.min.y, 0), axis: Z, max: 0.3 };
    case 'exhaust': return { hinge: v(b.max.x, 0, 0), axis: Z, max: 0.35 };
    case 'grille': return { hinge: v(0, b.max.y, 0), axis: Z, max: 0.4 };
    default:
      if (name.startsWith('wheel')) return { hinge: v(0, 0, 0), axis: X, max: 0 };
      return { hinge: v(0, 0, 0), axis: Z, max: 0.12 };
  }
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class Car {
  /** Position / heading. */
  readonly root = new THREE.Group();
  /** Roll, pitch and sag, relative to the root. */
  readonly body = new THREE.Group();
  parts: CarPart[] = [];

  // Physics state (metres, seconds, radians).
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vz = 0;
  vy = 0;
  heading = 0;
  yawRate = 0;
  steerAngle = 0;
  airborne = false;
  /** Forward speed (m/s), signed. */
  speed = 0;
  /** -1 = reverse, 1..6 forward. */
  gear = 1;
  rpm = IDLE_RPM;
  autoGearbox = true;
  /** Seconds left in the current gear change (drive is cut). */
  shiftTimer = 0;
  private limiterTimer = 0;
  /** Ground height under the car last step, to get how fast the ground rises or falls. */
  private lastGround = 0;
  private terrainPitch = 0;
  private terrainRoll = 0;
  private wheelSpin = 0;
  private longAccel = 0;
  private roll = 0;
  private pitch = 0;
  private sag = 0;
  private bounce = 0;
  private bounceVel = 0;
  private detachQueue: DetachEvent[] = [];
  private query: Collider[] = [];
  private contact: Contact = { nx: 0, nz: 0, depth: 0 };

  constructor(
    private lib: ModelLibrary,
    private ground: GroundFn,
  ) {
    this.root.name = 'car';
    // Heading, then the terrain's pitch and roll in the car's own frame.
    this.root.rotation.order = 'YZX';
    this.root.add(this.body);
    this.build();
  }

  /** (Re)create every part in place. Old detached groups are left wherever they are. */
  build() {
    for (const p of this.parts) if (p.attached) this.body.remove(p.group);
    this.parts = [];
    for (const def of this.lib.values()) {
      const ex = def.extras as { pivot: number[]; category: string; detachable: boolean; mass: number };
      const pivot = new THREE.Vector3().fromArray(ex.pivot).multiplyScalar(UNIT);
      const offset = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
      const group = instantiate(def, offset);
      group.position.copy(pivot);
      const box = def.box.clone().translate(_v.copy(pivot).negate());
      const { hinge, axis, max } = hingeFor(def.name, box);
      const isWheel = ex.category === 'wheel';
      if (isWheel) group.rotation.order = 'YXZ';
      const hp = HP[ex.category] ?? 100;
      this.parts.push({
        name: def.name, category: ex.category, detachable: ex.detachable, mass: ex.mass,
        pivot, box, group, hp, maxHp: hp, attached: true,
        hinge, hingeAxis: axis, hangMax: max, wobble: 0, wobbleVel: 0,
        wheel: isWheel ? { front: pivot.x > 0, left: pivot.z < 0 } : null,
      });
      this.body.add(group);
    }
  }

  /** Teleport, stop, and optionally repair. */
  place(x: number, z: number, heading: number, repair: boolean) {
    if (repair) this.build();
    this.x = x;
    this.z = z;
    this.y = this.lastGround = this.ground(x, z);
    this.vx = this.vz = this.vy = 0;
    this.heading = heading;
    this.yawRate = 0;
    this.steerAngle = 0;
    this.airborne = false;
    this.speed = 0;
    this.gear = 1;
    this.rpm = IDLE_RPM;
    this.shiftTimer = 0;
    this.detachQueue.length = 0;
    this.syncVisual(0);
  }

  drainDetached(): DetachEvent[] {
    if (!this.detachQueue.length) return this.detachQueue;
    const out = this.detachQueue;
    this.detachQueue = [];
    return out;
  }

  get partsLost() {
    let n = 0;
    for (const p of this.parts) if (p.detachable && !p.attached) n++;
    return n;
  }

  get detachableCount() {
    let n = 0;
    for (const p of this.parts) if (p.detachable) n++;
    return n;
  }

  /** 0..1, how much of the car is left (by hit points, counting lost parts as zero). */
  get integrity() {
    let hp = 0, max = 0;
    for (const p of this.parts) {
      if (!p.detachable) continue;
      max += p.maxHp;
      if (p.attached) hp += Math.max(0, p.hp);
    }
    return max ? hp / max : 1;
  }

  /** Bitmask of attached wheels: 1 FL, 2 FR, 4 RL, 8 RR. */
  private wheelMask() {
    let m = 0;
    for (const p of this.parts) {
      if (!p.wheel || !p.attached) continue;
      m |= p.wheel.front ? (p.wheel.left ? 1 : 2) : p.wheel.left ? 4 : 8;
    }
    return m;
  }

  /** World positions of corners scraping the ground (missing wheels). */
  scrapePoints(out: THREE.Vector3[]): number {
    if (this.airborne) return 0;
    const mask = this.wheelMask();
    let n = 0;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const corners: [number, number, number][] = [[1, 1.2, -0.75], [2, 1.2, 0.75], [4, -1.3, -0.75], [8, -1.3, 0.75]];
    for (const [bit, lx, lz] of corners) {
      if (mask & bit) continue;
      // local (lx, lz) -> world: lx * (c, -s) + lz * (s, c)
      out[n++].set(this.x + lx * c + lz * s, this.y + 0.05, this.z - lx * s + lz * c);
    }
    return n;
  }

  step(dt: number, input: Controls | null, env: CarEnv) {
    const fx = Math.cos(this.heading), fz = -Math.sin(this.heading);
    const rx = -fz, rz = fx;
    let vF = this.vx * fx + this.vz * fz;
    let vR = this.vx * rx + this.vz * rz;
    const prevVF = vF;

    const mask = this.wheelMask();
    const front = (mask & 1 ? 1 : 0) + (mask & 2 ? 1 : 0);
    const rear = (mask & 4 ? 1 : 0) + (mask & 8 ? 1 : 0);
    const wheels = front + rear;
    const missingLeft = (mask & 1 ? 0 : 1) + (mask & 4 ? 0 : 1);
    const missingRight = (mask & 2 ? 0 : 1) + (mask & 8 ? 0 : 1);
    const surface = env.onRoad ? 'road' : 'grass';

    const throttle = input?.throttle ?? 0;
    const brake = input ? input.brake : 1;
    const steer = input?.steer ?? 0;
    const handbrake = input?.handbrake ?? false;

    if (!this.airborne) {
      // Longitudinal: front-wheel drive, so losing front wheels costs drive.
      const drive = 0.3 + 0.7 * (front / 2);
      const top = TOP_SPEED * (env.onRoad ? 1 : 0.6) * (0.45 + 0.55 * (wheels / 4));
      let a = 0;
      if (throttle > 0) {
        if (vF < -0.5) a += BRAKE * throttle;
        else a += ENGINE * drive * throttle * Math.max(0, 1 - vF / top) * this.gearFactor(throttle);
      }
      // Too low a gear (manual): engine braking.
      if (this.gear > 0 && vF > GEAR_TOP[this.gear] * 1.02) a -= 4;
      if (brake > 0) {
        if (vF > 0.5) a -= BRAKE * brake;
        else if (input) a -= ENGINE * 0.6 * brake * Math.max(0, 1 + vF / REVERSE_TOP);
      }
      if (handbrake) a -= Math.sign(vF) * 5;
      // Gravity along the slope: uphill slows you, downhill speeds you up.
      const slope = (this.ground(this.x + fx * 1.25, this.z + fz * 1.25) - this.ground(this.x - fx * 1.25, this.z - fz * 1.25)) / 2.5;
      a -= (GRAVITY * slope) / Math.sqrt(1 + slope * slope);
      vF += a * dt;
      const resist = (ROLLING + (env.onRoad ? 0 : 2.2) + (4 - wheels) * 2.4 + AIR_DRAG * vF * vF) * dt;
      vF -= Math.sign(vF) * Math.min(Math.abs(vF), resist);
      if (!input && Math.abs(vF) < 0.5) vF = 0;

      // Steering: kinematic yaw rate, capped by the available lateral grip.
      const speed = Math.abs(vF);
      const limit = MAX_STEER / (1 + speed / 18);
      this.steerAngle += (steer * limit - this.steerAngle) * damp(12, dt);
      const authority = 0.25 + 0.75 * (front / 2);
      let target = (vF / WHEELBASE) * Math.tan(this.steerAngle) * authority;
      const latMax = LAT_ACCEL[surface] * (0.5 + 0.5 * (wheels / 4)) * (handbrake ? 1.6 : 1);
      const cap = latMax / Math.max(speed, 1);
      target = clamp(target, -cap, cap);
      // A dragging corner pulls the car towards it.
      target += (missingLeft - missingRight) * 0.07 * clamp(vF / 10, -1.5, 1.5);
      this.yawRate += (target - this.yawRate) * damp(handbrake ? 3 : env.onRoad ? 7 : 4, dt);

      // Lateral grip bleeds off sideways velocity; the handbrake lets it slide.
      const grip = handbrake ? GRIP.handbrake : GRIP[surface] * (0.4 + 0.6 * (wheels / 4));
      vR *= Math.exp(-grip * dt);
    } else {
      // A little air control, for style.
      this.yawRate += steer * 1.2 * dt;
      this.yawRate *= 1 - 0.4 * dt;
      this.steerAngle += (steer * MAX_STEER * 0.5 - this.steerAngle) * damp(8, dt);
    }

    this.vx = fx * vF + rx * vR;
    this.vz = fz * vF + rz * vR;
    this.heading += this.yawRate * dt;
    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.longAccel += ((vF - prevVF) / dt - this.longAccel) * damp(6, dt);

    // ---- Vertical: hills, ramps, jumps, landings -------------------------
    // The car is always ballistic; the ground just stops it going under. Over a
    // crest the ground falls away faster than gravity can follow, so you fly.
    let h = this.ground(this.x, this.z) + rampHeight(env.ramps, this.x, this.z);
    if (!this.airborne && h > this.y + 0.45) {
      // Drove into the ramp's tall end: treat it as a wall.
      this.x -= this.vx * dt;
      this.z -= this.vz * dt;
      const sev = Math.abs(vF);
      this.vx *= -0.3;
      this.vz *= -0.3;
      this.applyDamage(Math.sign(vF) * 2, 0, sev, 0.4, -fx * Math.sign(vF), -fz * Math.sign(vF));
      h = this.ground(this.x, this.z) + rampHeight(env.ramps, this.x, this.z);
      this.lastGround = h;
    }
    const groundVy = (h - this.lastGround) / dt;
    this.lastGround = h;
    this.vy -= GRAVITY * dt;
    this.y += this.vy * dt;
    if (this.y <= h) {
      const impact = groundVy - this.vy;
      if (this.airborne) {
        this.bounceVel -= Math.min(impact, 20) * 0.06;
        if (impact > 7) this.landingDamage(impact - 6);
      }
      this.y = h;
      this.vy = groundVy;
      this.airborne = false;
    } else if (this.y > h + 0.12) {
      this.airborne = true;
    }

    this.collideStatic(env);
    this.collidePushables(env);
    this.speed = this.vx * Math.cos(this.heading) - this.vz * Math.sin(this.heading);
    this.updateGearbox(dt, throttle, brake);

    // Wheels roll with the car.
    if (!this.airborne) this.wheelSpin += (this.speed * dt) / WHEEL_RADIUS;
    else this.wheelSpin += throttle * 30 * dt;
  }

  /** Drive multiplier from the gear and the torque curve; zero mid-shift or on the limiter. */
  private gearFactor(throttle: number) {
    if (this.gear < 0) return 1;
    if (this.shiftTimer > 0 || this.limiterTimer > 0) return 0.08;
    // Judge the limiter on what the wheels say the engine is doing, not the
    // smoothed tacho, or the bounce lets drive leak through past the redline.
    const wheelRpm = IDLE_RPM + (Math.max(this.speed, 0) / GEAR_TOP[this.gear]) * (REDLINE_RPM - IDLE_RPM);
    if (throttle > 0 && Math.max(wheelRpm, this.rpm) >= LIMIT_RPM - 30) {
      this.limiterTimer = 0.07;
      return 0.08;
    }
    return GEAR_PULL[this.gear] * torque(this.rpm);
  }

  shift(dir: 1 | -1) {
    const next = this.gear < 0 ? (dir > 0 ? 1 : -1) : this.gear + dir;
    if (next < 1 || next > 6 || this.shiftTimer > 0) return;
    this.gear = next;
    this.shiftTimer = SHIFT_TIME;
  }

  private updateGearbox(dt: number, throttle: number, brake: number) {
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.limiterTimer = Math.max(0, this.limiterTimer - dt);
    const v = this.speed;
    // Reverse is automatic either way: hold brake when stopped.
    if (v < -0.3 && brake > 0) this.gear = -1;
    else if (this.gear < 0 && (v > 0.3 || throttle > 0)) this.gear = 1;

    let target: number;
    if (this.airborne) {
      // Wheels in the air: the engine revs freely.
      target = IDLE_RPM + throttle * (LIMIT_RPM - IDLE_RPM);
    } else if (this.gear < 0) {
      target = IDLE_RPM + (Math.abs(v) / 10) * (REDLINE_RPM - IDLE_RPM) * 0.8;
    } else {
      target = IDLE_RPM + (Math.max(v, 0) / GEAR_TOP[this.gear]) * (REDLINE_RPM - IDLE_RPM);
      // Clutch slip pulling away in first.
      if (this.gear === 1) target = Math.max(target, IDLE_RPM + throttle * 2600);
    }
    if (this.shiftTimer > 0) target = Math.min(target, this.rpm);
    this.rpm += (Math.min(target, LIMIT_RPM) - this.rpm) * damp(this.airborne ? 6 : 14, dt);
    if (this.limiterTimer > 0) this.rpm -= 900 * dt * 10;

    if (this.autoGearbox && this.gear > 0 && this.shiftTimer <= 0 && !this.airborne) {
      if (this.rpm > UPSHIFT_RPM && this.gear < 6 && throttle > 0) this.shift(1);
      else if (this.rpm < DOWNSHIFT_RPM && this.gear > 1) this.shift(-1);
    }
  }

  /** Blip the throttle while held on the grid. */
  idleRev(dt: number, throttle: number) {
    this.limiterTimer = Math.max(0, this.limiterTimer - dt);
    let target = IDLE_RPM + throttle * (LIMIT_RPM - IDLE_RPM);
    if (this.limiterTimer > 0) target = LIMIT_RPM - 1200;
    else if (this.rpm > LIMIT_RPM - 40) this.limiterTimer = 0.08;
    this.rpm += (target - this.rpm) * damp(throttle > this.rpm / LIMIT_RPM ? 9 : 4, dt);
  }

  private collideStatic(env: CarEnv) {
    const fx = Math.cos(this.heading), fz = -Math.sin(this.heading);
    for (const o of CIRCLES) {
      let cx = this.x + fx * o, cz = this.z + fz * o;
      const n = env.world.query(cx, cz, CIRCLE_R, this.query);
      for (let k = 0; k < n; k++) {
        const col = this.query[k];
        if (this.y > col.top) continue;
        if (!circleVsCollider(cx, cz, CIRCLE_R, col, this.contact)) continue;
        const { nx, nz, depth } = this.contact;
        this.x += nx * depth;
        this.z += nz * depth;
        cx += nx * depth;
        cz += nz * depth;
        const rx = cx - nx * CIRCLE_R - this.x;
        const rz = cz - nz * CIRCLE_R - this.z;
        const sev = this.impulse(rx, rz, nx, nz, 0, col.restitution);
        if (sev > 0) {
          this.damageAtWorldOffset(rx, rz, sev, 0.45, nx, nz);
          if (sev > 4) env.onImpact(this.x + rx, this.y + 0.4, this.z + rz, sev);
        }
      }
    }
  }

  private collidePushables(env: CarEnv) {
    const fx = Math.cos(this.heading), fz = -Math.sin(this.heading);
    for (const list of env.pushables) {
      for (const { body: b, hardness } of list) {
        const ddx = b.pos.x - this.x, ddz = b.pos.z - this.z;
        const reach = b.radius + 2.2 + CIRCLE_R;
        if (ddx * ddx + ddz * ddz > reach * reach) continue;
        if (b.pos.y - b.halfHeight > this.y + ROOF) continue;
        if (b.pos.y + b.halfHeight < this.y) continue;
        for (const o of CIRCLES) {
          const cx = this.x + fx * o, cz = this.z + fz * o;
          const dx = b.pos.x - cx, dz = b.pos.z - cz;
          const rr = CIRCLE_R + b.radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= rr * rr || d2 < 1e-8) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d, nz = dz / d;
          const depth = rr - d;
          const wCar = (1 / MASS) / (1 / MASS + b.invMass);
          this.x -= nx * depth * wCar;
          this.z -= nz * depth * wCar;
          b.pos.x += nx * depth * (1 - wCar);
          b.pos.z += nz * depth * (1 - wCar);
          // Normal points from the car into the body; flip for the car-side impulse.
          const rx = cx + nx * CIRCLE_R - this.x;
          const rz = cz + nz * CIRCLE_R - this.z;
          const vpx = this.vx + this.yawRate * rz;
          const vpz = this.vz - this.yawRate * rx;
          const vrel = (vpx - b.vel.x) * nx + (vpz - b.vel.z) * nz;
          if (!b.awake) b.wake();
          if (vrel <= 0) continue;
          const rn = rz * nx - rx * nz;
          const j = (1.3 * vrel) / (1 / MASS + (rn * rn) / INERTIA + b.invMass);
          this.vx -= (nx * j) / MASS;
          this.vz -= (nz * j) / MASS;
          this.yawRate -= (rn * j) / INERTIA;
          const dv = j * b.invMass;
          b.vel.x += nx * dv;
          b.vel.z += nz * dv;
          // Light things get launched and sent tumbling.
          b.vel.y += Math.min(dv * 0.3, 7);
          const spin = Math.min(dv / Math.max(b.radius, 0.2), 25) * 0.6;
          b.ang.x += nz * spin + (Math.random() - 0.5) * spin * 0.4;
          b.ang.z -= nx * spin;
          b.ang.y += (Math.random() - 0.5) * spin;
          const sev = (j / MASS) * hardness;
          if (sev > DAMAGE_THRESHOLD) {
            this.damageAtWorldOffset(rx, rz, sev, 0.5, -nx, -nz);
            env.onImpact(this.x + rx, this.y + 0.5, this.z + rz, sev * 0.6);
          }
        }
      }
    }
  }

  /**
   * Impulse at world offset (rx, rz) from the car centre along normal n
   * (pointing at the car). Returns the closing speed, or 0 if separating.
   */
  private impulse(rx: number, rz: number, nx: number, nz: number, invMassOther: number, e: number) {
    const vpx = this.vx + this.yawRate * rz;
    const vpz = this.vz - this.yawRate * rx;
    const vn = vpx * nx + vpz * nz;
    if (vn >= 0) return 0;
    const rn = rz * nx - rx * nz;
    const j = (-(1 + e) * vn) / (1 / MASS + (rn * rn) / INERTIA + invMassOther);
    this.vx += (nx * j) / MASS;
    this.vz += (nz * j) / MASS;
    this.yawRate += (rn * j) / INERTIA;
    // Friction along the wall, so scrapes slow you down.
    const tx = vpx - vn * nx, tz = vpz - vn * nz;
    const tl = Math.hypot(tx, tz);
    if (tl > 1e-3) {
      const ux = tx / tl, uz = tz / tl;
      const rt = rz * ux - rx * uz;
      const jt = Math.min(tl / (1 / MASS + (rt * rt) / INERTIA), 0.35 * j);
      this.vx -= (ux * jt) / MASS;
      this.vz -= (uz * jt) / MASS;
      this.yawRate -= (rt * jt) / INERTIA;
    }
    return -vn;
  }

  private damageAtWorldOffset(rx: number, rz: number, sev: number, ly: number, nx: number, nz: number) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    // world offset -> local: x along (c, -s), z along (s, c)
    this.applyDamage(rx * c - rz * s, rx * s + rz * c, sev, ly, nx, nz);
  }

  private landingDamage(sev: number) {
    for (const [lx, lz] of [[1.2, -0.76], [1.2, 0.76], [-1.3, -0.76], [-1.3, 0.76]]) {
      this.applyDamage(lx, lz, sev, 0.1, 0, 0);
    }
  }

  /** Damage parts near a car-local point. `nx, nz` is the world direction to throw them. */
  applyDamage(lx: number, lz: number, severity: number, ly: number, nx: number, nz: number) {
    if (severity < DAMAGE_THRESHOLD) return;
    const dmg = Math.pow(severity - DAMAGE_THRESHOLD, 1.3) * DAMAGE_SCALE;
    for (const p of this.parts) {
      if (!p.attached) continue;
      const dx = p.pivot.x - lx, dz = p.pivot.z - lz, dy = (p.pivot.y - ly) * 0.6;
      const w = Math.exp(-(dx * dx + dz * dz + dy * dy) / DAMAGE_SPREAD);
      if (w < 0.04) continue;
      p.wobbleVel += severity * w * (Math.random() < 0.5 ? -1 : 1) * 0.6;
      if (!p.detachable) continue;
      p.hp -= dmg * w;
      if (p.hp <= 0) this.detach(p, nx, nz, severity);
    }
  }

  private detach(p: CarPart, nx: number, nz: number, severity: number) {
    if (!p.attached) return;
    p.attached = false;
    p.hp = 0;
    this.detachQueue.push({ part: p, nx, nz, severity });
    for (const child of CHILDREN[p.name] ?? []) {
      const c = this.parts.find((q) => q.name === child);
      if (c) this.detach(c, nx, nz, severity);
    }
  }

  /** World-space velocity of a car-local point (for things flying off). */
  pointVelocity(lx: number, lz: number, out: THREE.Vector3) {
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const rx = lx * c + lz * s, rz = -lx * s + lz * c;
    return out.set(this.vx + this.yawRate * rz, this.airborne ? this.vy : 0, this.vz - this.yawRate * rx);
  }

  syncVisual(dt: number) {
    this.root.position.set(this.x, this.y + 0.09, this.z);
    // Sit on the slope: pitch from front/back ground heights, roll from left/right.
    if (!this.airborne) {
      const c = Math.cos(this.heading), s = Math.sin(this.heading);
      const g = this.ground;
      const front = g(this.x + c * 1.25, this.z - s * 1.25), back = g(this.x - c * 1.25, this.z + s * 1.25);
      const left = g(this.x - s * 0.76, this.z - c * 0.76), right = g(this.x + s * 0.76, this.z + c * 0.76);
      const k = dt > 0 ? damp(14, dt) : 1;
      this.terrainPitch += (Math.atan2(front - back, 2.5) - this.terrainPitch) * k;
      this.terrainRoll += (Math.atan2(left - right, 1.52) - this.terrainRoll) * k;
    }
    this.root.rotation.set(this.terrainRoll, this.heading, this.terrainPitch);

    const mask = this.wheelMask();
    const drop = (bit: number) => (mask & bit ? 0 : 0.26);
    const fl = drop(1), fr = drop(2), rl = drop(4), rr = drop(8);
    const lat = this.yawRate * this.speed;
    let roll = clamp(lat * 0.0045, -0.07, 0.07) + ((fr + rr) - (fl + rl)) / 2 / TRACK_WIDTH;
    let pitch = clamp(this.longAccel * 0.004, -0.06, 0.06) - ((fl + fr) - (rl + rr)) / 2 / WHEELBASE;
    if (this.airborne) pitch += Math.atan2(this.vy, Math.abs(this.speed) + 5) * 0.5;
    const sag = -(fl + fr + rl + rr) / 4;
    const k = dt > 0 ? damp(8, dt) : 1;
    this.roll += (roll - this.roll) * k;
    this.pitch += (pitch - this.pitch) * k;
    this.sag += (sag - this.sag) * k;
    // Suspension bounce from landings.
    if (dt > 0) {
      this.bounceVel += (-120 * this.bounce - 10 * this.bounceVel) * dt;
      this.bounce += this.bounceVel * dt;
    }
    this.body.rotation.set(this.roll, 0, this.pitch);
    this.body.position.y = this.sag + clamp(this.bounce, -0.15, 0.15);

    const shake = Math.min(Math.abs(this.speed) * 0.02, 1);
    for (const p of this.parts) {
      if (!p.attached) continue;
      const loose = clamp((0.8 - p.hp / p.maxHp) / 0.8, 0, 1);
      if (dt > 0) {
        if (loose > 0) p.wobbleVel += (Math.random() - 0.5) * shake * loose * 3;
        p.wobbleVel += (-70 * p.wobble - 7 * p.wobbleVel) * dt;
        p.wobble += p.wobbleVel * dt;
      }
      if (p.wheel) {
        const camber = p.wobble * 0.15 + loose * 0.18 * (p.wheel.left ? 1 : -1);
        p.group.rotation.set(camber, p.wheel.front ? this.steerAngle : 0, -this.wheelSpin);
        continue;
      }
      const angle = p.hangMax * loose + p.wobble * (0.04 + loose * 0.3);
      if (Math.abs(angle) < 1e-4) {
        p.group.position.copy(p.pivot);
        p.group.quaternion.identity();
        continue;
      }
      // Rotate about the hinge: pos = pivot + hinge - R * hinge.
      _q.setFromAxisAngle(p.hingeAxis, angle);
      p.group.quaternion.copy(_q);
      p.group.position.copy(p.pivot).add(p.hinge).sub(_v.copy(p.hinge).applyQuaternion(_q));
    }
  }
}
