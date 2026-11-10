import * as THREE from 'three';
import type { Car } from './car';
import { damp, wrapAngle } from './math';
import type { GroundFn } from './rigidbody';

export const CAMERA_MODES = ['Chase', 'Far chase', 'Bonnet'] as const;

/** Smoothed chase camera with a speed-based FOV punch and shake. */
export class ChaseCamera {
  mode = 0;
  private yaw = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private shake = 0;
  private initialised = false;
  private desired = new THREE.Vector3();
  private target = new THREE.Vector3();
  private lagSpeed = 0;
  /** Camera and look-at positions relative to the car, smoothed (so lag doesn't grow with speed). */
  private offset = new THREE.Vector3();
  private lookOffset = new THREE.Vector3();
  private carPos = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private ground: GroundFn,
  ) {}

  cycle() {
    this.mode = (this.mode + 1) % CAMERA_MODES.length;
    this.initialised = false;
  }

  addShake(amount: number) {
    this.shake = Math.min(this.shake + amount, 1.2);
  }

  snap() {
    this.initialised = false;
  }

  /** Carry on from wherever the camera is now (e.g. after a cinematic), easing back. */
  resumeFrom(position: THREE.Vector3, look: THREE.Vector3, car: Car) {
    this.carPos.set(car.x, car.y, car.z);
    this.offset.copy(position).sub(this.carPos);
    this.lookOffset.copy(look).sub(this.carPos);
    this.yaw = car.heading;
    this.initialised = true;
  }

  update(dt: number, car: Car) {
    const cam = this.camera;
    const heading = car.heading;
    if (!this.initialised) this.yaw = heading;
    this.yaw += wrapAngle(heading - this.yaw) * damp(this.mode === 2 ? 30 : 5, dt);
    const fx = Math.cos(this.yaw), fz = -Math.sin(this.yaw);
    const speed = Math.abs(car.speed);
    // The camera falls back a little under hard acceleration, and catches up after.
    this.lagSpeed += (speed - this.lagSpeed) * damp(1.5, dt);
    const surge = Math.max(-1, Math.min(1.4, (speed - this.lagSpeed) * 0.2));

    const desired = this.desired;
    const look = this.target;
    if (this.mode === 2) {
      const c = Math.cos(car.heading), s = -Math.sin(car.heading);
      desired.set(car.x + c * 0.2, car.y + 1.2, car.z + s * 0.2);
      look.set(car.x + c * 20, car.y + 0.9, car.z + s * 20);
    } else {
      const far = this.mode === 1;
      const dist = (far ? 9.5 : 5.4) + speed * 0.03 + surge;
      const height = far ? 3.6 : 1.9;
      desired.set(car.x - fx * dist, car.y + height, car.z - fz * dist);
      look.set(car.x + fx * 5, car.y + 0.8, car.z + fz * 5);
    }

    const carPos = this.carPos.set(car.x, car.y, car.z);
    desired.sub(carPos);
    look.sub(carPos);
    if (!this.initialised) {
      this.offset.copy(desired);
      this.lookOffset.copy(look);
      this.initialised = true;
    } else {
      const bonnet = this.mode === 2;
      this.offset.lerp(desired, bonnet ? 1 : damp(6, dt));
      this.lookOffset.lerp(look, bonnet ? 1 : damp(12, dt));
      // Vertical lags a touch so jumps and crests feel like something.
      this.offset.y += (desired.y - this.offset.y) * (bonnet ? 1 : damp(5, dt));
    }
    this.pos.copy(carPos).add(this.offset);
    this.look.copy(carPos).add(this.lookOffset);

    cam.position.copy(this.pos);
    // Constant high-speed buzz plus impact shake.
    const buzz = Math.max(0, speed - 30) * 0.0016;
    const s = this.shake * 0.25 + buzz;
    if (s > 0.0005) {
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
    }
    this.shake *= Math.exp(-6 * dt);
    const floor = this.ground(cam.position.x, cam.position.z) + 0.5;
    if (cam.position.y < floor) cam.position.y = floor;
    cam.lookAt(this.look);

    const fov = (this.mode === 2 ? 72 : 62) + Math.min(speed * 0.42, 26);
    if (Math.abs(cam.fov - fov) > 0.05) {
      cam.fov += (fov - cam.fov) * damp(3, dt);
      cam.updateProjectionMatrix();
    }
  }

  /** Where the camera is looking (for handing over to another camera). */
  get lookTarget() {
    return this.look;
  }
}

/**
 * Crash cam: cuts to a low orbit around a flying part and tracks it while
 * time is slowed. Runs on real (unscaled) time so the orbit stays smooth.
 */
export class CinematicCamera {
  private angle = 0;
  private radius = 5;
  private height = 1.4;
  private pos = new THREE.Vector3();
  readonly look = new THREE.Vector3();
  private centre = new THREE.Vector3();
  private desired = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private ground: GroundFn,
  ) {}

  start(target: THREE.Vector3, car: Car) {
    // Start side-on to the car's travel, on a random side, so the part flies across frame.
    const travel = Math.atan2(car.vz, car.vx);
    const side = Math.random() < 0.5 ? 1 : -1;
    this.angle = travel + side * (Math.PI / 2 + 0.35);
    this.radius = 4.5 + Math.random() * 1.5;
    this.height = 0.9 + Math.random() * 1.0;
    this.centre.copy(target);
    this.place(target, car);
    this.pos.copy(this.desired);
    this.look.copy(target);
  }

  private place(target: THREE.Vector3, car: Car) {
    // Frame mostly the part, with the car pulled in a little.
    this.centre.set(target.x * 0.75 + car.x * 0.25, target.y * 0.75 + (car.y + 0.6) * 0.25, target.z * 0.75 + car.z * 0.25);
    this.desired.set(
      this.centre.x + Math.cos(this.angle) * this.radius,
      this.centre.y + this.height,
      this.centre.z + Math.sin(this.angle) * this.radius,
    );
    const floor = this.ground(this.desired.x, this.desired.z) + 0.4;
    if (this.desired.y < floor) this.desired.y = floor;
  }

  update(realDt: number, target: THREE.Vector3, car: Car) {
    this.angle += 0.35 * realDt;
    this.place(target, car);
    this.pos.lerp(this.desired, damp(4, realDt));
    this.look.lerp(target, damp(9, realDt));
    const cam = this.camera;
    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - 46) > 0.05) {
      cam.fov += (46 - cam.fov) * damp(6, realDt);
      cam.updateProjectionMatrix();
    }
  }
}
