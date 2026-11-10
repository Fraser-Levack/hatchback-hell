import * as THREE from 'three';

export const GRAVITY = 12;

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _r = new THREE.Vector3();
const _p = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _t = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export type GroundFn = (x: number, z: number) => number;

export type HullShape = 'box' | 'cylinderY' | 'cylinderZ' | 'cone';

/** Hull points (relative to the centre of mass) used for ground contacts. */
export function makeHull(shape: HullShape, half: THREE.Vector3, segments = 10): Float32Array {
  const pts: number[] = [];
  const { x: hx, y: hy, z: hz } = half;
  if (shape === 'box') {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push(sx * hx, sy * hy, sz * hz);
  } else if (shape === 'cylinderZ') {
    const r = Math.min(hx, hy);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      for (const sz of [-1, 1]) pts.push(Math.cos(a) * r, Math.sin(a) * r, sz * hz);
    }
  } else {
    const r = Math.min(hx, hz);
    const topR = shape === 'cone' ? r * 0.18 : r;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(Math.cos(a) * r, -hy, Math.sin(a) * r);
      pts.push(Math.cos(a) * topR, hy, Math.sin(a) * topR);
    }
  }
  return new Float32Array(pts);
}

/**
 * A minimal rigid body that only collides with the ground (a height function)
 * via its hull points. Sideways collisions are handled by whoever owns the body.
 */
export class RigidBody {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  quat = new THREE.Quaternion();
  ang = new THREE.Vector3();
  mass: number;
  invMass: number;
  /** Diagonal of the local inverse inertia tensor. */
  invInertia = new THREE.Vector3();
  hull: Float32Array;
  /** Horizontal collision radius. */
  radius: number;
  /** Half height, for vertical overlap tests. */
  halfHeight: number;
  restitution = 0.3;
  friction = 0.7;
  /** Spin damping while touching the ground (per second). Low for wheels so they roll away. */
  groundSpinDamping = 1.2;
  awake = false;
  private sleepTime = 0;

  constructor(mass: number, half: THREE.Vector3, hull: Float32Array) {
    this.mass = mass;
    this.invMass = 1 / mass;
    const { x, y, z } = half;
    // Solid box inertia, I = m/3 (b^2 + c^2) with half extents.
    this.invInertia.set(3 / (mass * (y * y + z * z)), 3 / (mass * (x * x + z * z)), 3 / (mass * (x * x + y * y)));
    this.hull = hull;
    this.radius = Math.max(Math.hypot(x, z) * 0.85, 0.15);
    this.halfHeight = Math.max(x, y, z) * 0.8;
  }

  wake() {
    this.awake = true;
    this.sleepTime = 0;
  }

  /** World-space inverse inertia applied to v (in place). */
  private applyInvInertia(v: THREE.Vector3) {
    _qi.copy(this.quat).invert();
    v.applyQuaternion(_qi).multiply(this.invInertia).applyQuaternion(this.quat);
    return v;
  }

  /** Apply impulse J at world-space offset r from the centre of mass. */
  applyImpulse(J: THREE.Vector3, r: THREE.Vector3) {
    this.vel.addScaledVector(J, this.invMass);
    this.ang.add(this.applyInvInertia(_a.crossVectors(r, J)));
  }

  /** Effective inverse mass along direction n at offset r. */
  private effInvMass(r: THREE.Vector3, n: THREE.Vector3) {
    _a.crossVectors(r, n);
    this.applyInvInertia(_a);
    _b.crossVectors(_a, r);
    return this.invMass + n.dot(_b);
  }

  step(dt: number, ground: GroundFn) {
    if (!this.awake) return;
    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    const w = this.ang.length();
    if (w > 1e-6) {
      _q.setFromAxisAngle(_a.copy(this.ang).divideScalar(w), w * dt);
      this.quat.premultiply(_q).normalize();
    }

    // Ground contacts: two passes of sequential impulses over the hull points.
    const h = this.hull;
    let minY = Infinity;
    let touching = false;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < h.length; i += 3) {
        _r.set(h[i], h[i + 1], h[i + 2]).applyQuaternion(this.quat);
        const y = this.pos.y + _r.y - ground(this.pos.x + _r.x, this.pos.z + _r.z);
        if (pass === 1 && y < minY) minY = y;
        if (y > 0) continue;
        touching = true;
        _vp.crossVectors(this.ang, _r).add(this.vel);
        if (_vp.y >= 0) continue;
        const e = pass === 0 && _vp.y < -2 ? this.restitution : 0;
        const j = (-(1 + e) * _vp.y) / this.effInvMass(_r, UP);
        this.applyImpulse(_p.set(0, j, 0), _r);
        // Coulomb friction along the sliding direction.
        _vp.crossVectors(this.ang, _r).add(this.vel);
        _t.set(-_vp.x, 0, -_vp.z);
        const slide = _t.length();
        if (slide > 1e-4) {
          _t.divideScalar(slide);
          const jt = Math.min(slide / this.effInvMass(_r, _t), this.friction * j);
          this.applyImpulse(_p.copy(_t).multiplyScalar(jt), _r);
        }
      }
    }
    if (minY < 0) this.pos.y -= minY;

    // Air drag and a little rolling resistance so things settle.
    const lin = touching ? 0.6 : 0.05;
    this.vel.x *= 1 - lin * dt;
    this.vel.z *= 1 - lin * dt;
    this.ang.multiplyScalar(1 - (touching ? this.groundSpinDamping : 0.1) * dt);

    if (touching && this.vel.lengthSq() < 0.05 && this.ang.lengthSq() < 0.1) {
      this.sleepTime += dt;
      if (this.sleepTime > 0.5) {
        this.awake = false;
        this.vel.set(0, 0, 0);
        this.ang.set(0, 0, 0);
      }
    } else {
      this.sleepTime = 0;
    }
  }
}
