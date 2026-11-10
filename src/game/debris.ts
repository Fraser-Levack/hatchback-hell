import * as THREE from 'three';
import type { Car, DetachEvent, Pushable } from './car';
import { circleVsCollider, type Collider, type Contact, type StaticWorld } from './collision';
import { makeHull, RigidBody, type GroundFn } from './rigidbody';

export interface Debris extends Pushable {
  group: THREE.Group;
  name: string;
}

const MAX_DEBRIS = 70;
const _v = new THREE.Vector3();

/** Car parts that have come off: they tumble, roll, settle and can be kicked about. */
export class DebrisSystem {
  readonly items: Debris[] = [];
  private query: Collider[] = [];
  private contact: Contact = { nx: 0, nz: 0, depth: 0 };

  constructor(
    private scene: THREE.Scene,
    private ground: GroundFn,
  ) {}

  spawn(car: Car, ev: DetachEvent): Debris {
    const { part, nx, nz, severity } = ev;
    const g = part.group;
    // Move into world space, keeping where it is right now.
    g.updateWorldMatrix(true, false);
    this.scene.attach(g);

    const half = part.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    half.max(new THREE.Vector3(0.05, 0.05, 0.05));
    const centre = part.box.getCenter(new THREE.Vector3());
    const hull = makeHull(part.wheel ? 'cylinderZ' : 'box', half, part.wheel ? 14 : 10);
    for (let i = 0; i < hull.length; i += 3) {
      hull[i] += centre.x;
      hull[i + 1] += centre.y;
      hull[i + 2] += centre.z;
    }
    const body = new RigidBody(Math.max(part.mass, 0.5), half, hull);
    body.pos.copy(g.position);
    body.quat.copy(g.quaternion);
    body.restitution = part.category === 'glass' ? 0.1 : 0.35;
    body.friction = part.wheel ? 0.9 : 0.6;
    if (part.wheel) body.groundSpinDamping = 0.15;

    car.pointVelocity(part.pivot.x, part.pivot.z, body.vel);
    const kick = Math.min(severity, 30) * 0.18;
    body.vel.x += nx * kick + (Math.random() - 0.5) * 2;
    body.vel.z += nz * kick + (Math.random() - 0.5) * 2;
    body.vel.y += 1.5 + Math.random() * 2.5 + kick * 0.3;
    const spin = 2 + Math.min(severity, 30) * 0.25;
    body.ang.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spin * 2);
    if (part.wheel) {
      // Keep it spinning about its axle so it rolls off down the track.
      _v.set(0, 0, 1).applyQuaternion(g.quaternion);
      body.ang.addScaledVector(_v, -car.speed / 0.31);
    }
    body.wake();

    const item: Debris = { group: g, name: part.name, body, hardness: 0.6 };
    this.items.push(item);
    while (this.items.length > MAX_DEBRIS) {
      const old = this.items.shift()!;
      this.scene.remove(old.group);
    }
    return item;
  }

  clear() {
    for (const d of this.items) this.scene.remove(d.group);
    this.items.length = 0;
  }

  update(dt: number, world: StaticWorld) {
    for (const d of this.items) {
      const b = d.body;
      if (!b.awake) continue;
      b.step(dt, this.ground);
      const n = world.query(b.pos.x, b.pos.z, b.radius, this.query);
      for (let k = 0; k < n; k++) {
        const col = this.query[k];
        if (b.pos.y - b.halfHeight > col.top) continue;
        if (!circleVsCollider(b.pos.x, b.pos.z, b.radius, col, this.contact)) continue;
        const { nx, nz, depth } = this.contact;
        b.pos.x += nx * depth;
        b.pos.z += nz * depth;
        const vn = b.vel.x * nx + b.vel.z * nz;
        if (vn < 0) {
          b.vel.x -= 1.3 * vn * nx;
          b.vel.z -= 1.3 * vn * nz;
        }
      }
    }
  }

  syncVisual() {
    for (const d of this.items) {
      d.group.position.copy(d.body.pos);
      d.group.quaternion.copy(d.body.quat);
    }
  }
}
