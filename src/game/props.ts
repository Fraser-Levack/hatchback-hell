import * as THREE from 'three';
import { instantiate, type ModelDef, type ModelLibrary } from './assets';
import { circleVsCollider, type Collider, type Contact, type StaticWorld } from './collision';
import { makeHull, RigidBody, type GroundFn, type HullShape } from './rigidbody';

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YZX');
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

/** One InstancedMesh per primitive of a model, all sharing instance indices. */
class InstancedModel {
  readonly meshes: THREE.InstancedMesh[];
  dirty = false;
  constructor(
    private def: ModelDef,
    count: number,
    dynamic: boolean,
  ) {
    this.meshes = def.pieces.map((p) => {
      const mesh = new THREE.InstancedMesh(p.geometry, p.material, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return mesh;
    });
  }

  set(i: number, world: THREE.Matrix4) {
    const pieces = this.def.pieces;
    for (let k = 0; k < pieces.length; k++) {
      this.meshes[k].setMatrixAt(i, _m2.multiplyMatrices(world, pieces[k].matrix));
    }
    this.dirty = true;
  }

  /** Upload changed matrices. Bounds are refreshed too so frustum culling stays correct. */
  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    for (const m of this.meshes) {
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
    }
  }

  computeBounds() {
    for (const m of this.meshes) m.computeBoundingSphere();
  }
}

export interface DynamicSpec {
  shape: HullShape;
  mass: number;
  /** How much a hit on this prop hurts the car, relative to its mass. */
  hardness: number;
}

export const DYNAMIC_PROPS: Record<string, DynamicSpec> = {
  traffic_cone: { shape: 'cone', mass: 4, hardness: 5 },
  oil_drum: { shape: 'cylinderY', mass: 30, hardness: 11 },
  tyre_stack: { shape: 'cylinderY', mass: 45, hardness: 4 },
  wooden_crate: { shape: 'box', mass: 25, hardness: 14 },
  hay_bale: { shape: 'cylinderZ', mass: 180, hardness: 3.5 },
};

export interface DynamicProp {
  name: string;
  spec: DynamicSpec;
  body: RigidBody;
  model: InstancedModel;
  index: number;
  /** Model-space centre of mass (m, before scale). */
  com: THREE.Vector3;
  scale: number;
  home: { x: number; z: number; yaw: number };
  moved: boolean;
}

const CHUNK = 70;

/**
 * All the scenery. Static props are batched into InstancedMeshes per model
 * per 70 m chunk, so the renderer can still frustum-cull (and shadow-cull)
 * them. Knockable props are instanced too, with one RigidBody each.
 */
export class PropSystem {
  readonly group = new THREE.Group();
  readonly dynamic: DynamicProp[] = [];
  private statics = new Map<string, { def: ModelDef; matrices: THREE.Matrix4[] }>();
  private dynModels = new Map<string, InstancedModel>();
  private pending: { name: string; x: number; z: number; yaw: number; scale: number }[] = [];
  private query: Collider[] = [];
  private contact: Contact = { nx: 0, nz: 0, depth: 0 };

  constructor(
    private lib: ModelLibrary,
    private ground: GroundFn,
  ) {
    this.group.name = 'props';
    this.group.matrixAutoUpdate = false;
  }

  def(name: string) {
    const d = this.lib.get(name);
    if (!d) throw new Error(`missing model ${name}`);
    return d;
  }

  /** Place a static prop. `y` defaults to the ground; `pitch` tilts its +X end up (for slopes). */
  addStatic(name: string, x: number, z: number, yaw: number, scale: number | THREE.Vector3 = 1, y?: number, pitch = 0) {
    const def = this.def(name);
    const key = `${name}|${Math.floor(x / CHUNK)}|${Math.floor(z / CHUNK)}`;
    let entry = this.statics.get(key);
    if (!entry) this.statics.set(key, (entry = { def, matrices: [] }));
    if (typeof scale === 'number') _s.setScalar(scale);
    else _s.copy(scale);
    _q.setFromEuler(_e.set(0, yaw, pitch));
    entry.matrices.push(new THREE.Matrix4().compose(_v.set(x, y ?? this.ground(x, z), z), _q, _s));
  }

  /** A one-off plain mesh group (e.g. a mirrored sign, which instancing can't draw). */
  addMesh(name: string, matrix: THREE.Matrix4) {
    const g = instantiate(this.def(name));
    g.matrixAutoUpdate = false;
    g.matrix.copy(matrix);
    this.group.add(g);
    return g;
  }

  addDynamic(name: string, x: number, z: number, yaw: number, scale = 1) {
    if (!DYNAMIC_PROPS[name]) throw new Error(`${name} is not a dynamic prop`);
    this.pending.push({ name, x, z, yaw, scale });
  }

  build() {
    for (const { def, matrices } of this.statics.values()) {
      const im = new InstancedModel(def, matrices.length, false);
      matrices.forEach((m, i) => im.set(i, m));
      im.computeBounds();
      for (const mesh of im.meshes) this.group.add(mesh);
    }

    // Knockable props are chunked by where they start, like the static ones. They
    // rarely travel far, so each chunk's bounds stay tight and it can be culled
    // from both the main and the shadow pass.
    const keyOf = (p: { name: string; x: number; z: number }) =>
      `${p.name}|${Math.floor(p.x / CHUNK)}|${Math.floor(p.z / CHUNK)}`;
    const counts = new Map<string, number>();
    for (const p of this.pending) counts.set(keyOf(p), (counts.get(keyOf(p)) ?? 0) + 1);
    for (const [key, count] of counts) {
      const im = new InstancedModel(this.def(key.split('|')[0]), count, true);
      this.dynModels.set(key, im);
      for (const mesh of im.meshes) this.group.add(mesh);
    }
    const next = new Map<string, number>();
    for (const p of this.pending) {
      const def = this.def(p.name);
      const spec = DYNAMIC_PROPS[p.name];
      const key = keyOf(p);
      const index = next.get(key) ?? 0;
      next.set(key, index + 1);
      const com = def.box.getCenter(new THREE.Vector3());
      const half = def.box.getSize(new THREE.Vector3()).multiplyScalar(0.5 * p.scale);
      const body = new RigidBody(spec.mass, half, makeHull(spec.shape, half));
      body.restitution = 0.35;
      this.dynamic.push({
        name: p.name, spec, body, model: this.dynModels.get(key)!, index, com,
        scale: p.scale, home: { x: p.x, z: p.z, yaw: p.yaw }, moved: true,
      });
    }
    this.pending.length = 0;
    this.reset();
  }

  /** Put every knockable prop back where it started. */
  reset() {
    for (const d of this.dynamic) {
      const b = d.body;
      b.quat.setFromAxisAngle(Y, d.home.yaw);
      b.pos.copy(d.com).multiplyScalar(d.scale).applyQuaternion(b.quat);
      b.pos.x += d.home.x;
      b.pos.z += d.home.z;
      b.pos.y += this.ground(d.home.x, d.home.z);
      b.vel.set(0, 0, 0);
      b.ang.set(0, 0, 0);
      b.awake = false;
      d.moved = true;
    }
    this.writeMatrices();
  }

  update(dt: number, world: StaticWorld) {
    const dyn = this.dynamic;
    for (let i = 0; i < dyn.length; i++) {
      const a = dyn[i];
      const ba = a.body;
      if (!ba.awake) continue;
      ba.step(dt, this.ground);
      a.moved = true;

      // Against the static world.
      const n = world.query(ba.pos.x, ba.pos.z, ba.radius, this.query);
      for (let k = 0; k < n; k++) {
        const col = this.query[k];
        if (ba.pos.y - ba.halfHeight > col.top) continue;
        if (!circleVsCollider(ba.pos.x, ba.pos.z, ba.radius, col, this.contact)) continue;
        const { nx, nz, depth } = this.contact;
        ba.pos.x += nx * depth;
        ba.pos.z += nz * depth;
        const vn = ba.vel.x * nx + ba.vel.z * nz;
        if (vn < 0) {
          ba.vel.x -= 1.4 * vn * nx;
          ba.vel.z -= 1.4 * vn * nz;
        }
      }

      // Against the other props, so knocked props can skittle each other.
      for (let j = 0; j < dyn.length; j++) {
        if (j === i) continue;
        const bb = dyn[j].body;
        const dx = bb.pos.x - ba.pos.x;
        const dz = bb.pos.z - ba.pos.z;
        const rr = ba.radius + bb.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-8) continue;
        if (Math.abs(bb.pos.y - ba.pos.y) > ba.halfHeight + bb.halfHeight) continue;
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        const depth = rr - d;
        const wa = ba.invMass / (ba.invMass + bb.invMass);
        ba.pos.x -= nx * depth * wa;
        ba.pos.z -= nz * depth * wa;
        bb.pos.x += nx * depth * (1 - wa);
        bb.pos.z += nz * depth * (1 - wa);
        const vrel = (ba.vel.x - bb.vel.x) * nx + (ba.vel.z - bb.vel.z) * nz;
        if (vrel > 0) {
          const j = (1.3 * vrel) / (ba.invMass + bb.invMass);
          ba.vel.x -= nx * j * ba.invMass;
          ba.vel.z -= nz * j * ba.invMass;
          bb.vel.x += nx * j * bb.invMass;
          bb.vel.z += nz * j * bb.invMass;
          if (vrel > 1) {
            bb.ang.x += nz * vrel * 0.8;
            bb.ang.z -= nx * vrel * 0.8;
          }
        }
        if (!bb.awake && depth > 0.01) bb.wake();
        dyn[j].moved = true;
      }
    }
    this.writeMatrices();
  }

  private writeMatrices() {
    for (const d of this.dynamic) {
      if (!d.moved) continue;
      d.moved = false;
      const b = d.body;
      // world = T(pos) R(quat) S(scale) T(-com)
      _m.compose(b.pos, b.quat, _s.setScalar(d.scale));
      _m.multiply(_m2.makeTranslation(-d.com.x, -d.com.y, -d.com.z));
      d.model.set(d.index, _m);
    }
    for (const m of this.dynModels.values()) m.flush();
  }
}
