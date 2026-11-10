/**
 * 2D (XZ-plane) collision for the static world, with a height per collider so
 * the car can fly over low things. Everything here allocates nothing per call.
 */

export enum Shape {
  Circle,
  Box,
}

export interface Collider {
  shape: Shape;
  x: number;
  z: number;
  /** Circle radius, or the box's bounding radius for broadphase. */
  r: number;
  /** Box half extents along its local X and Z. */
  hx: number;
  hz: number;
  /** cos / sin of the box yaw (local +X = (cos, -sin) in XZ). */
  c: number;
  s: number;
  /** Top of the collider (m). */
  top: number;
  restitution: number;
  /** Bumped every query so a collider spanning several cells is reported once. */
  stamp: number;
}

export interface Contact {
  /** Normal pointing from the collider towards the circle. */
  nx: number;
  nz: number;
  depth: number;
}

const CELL = 12;
const key = (cx: number, cz: number) => (cx + 1024) * 4096 + (cz + 1024);

export class StaticWorld {
  colliders: Collider[] = [];
  private grid = new Map<number, Collider[]>();
  private stamp = 0;

  addCircle(x: number, z: number, r: number, top = 3, restitution = 0.25) {
    this.insert({ shape: Shape.Circle, x, z, r, hx: 0, hz: 0, c: 1, s: 0, top, restitution, stamp: 0 });
  }

  /** `yaw` uses the same convention as rotation.y on a model facing +X. */
  addBox(x: number, z: number, hx: number, hz: number, yaw: number, top = 3, restitution = 0.25) {
    const r = Math.hypot(hx, hz);
    this.insert({ shape: Shape.Box, x, z, r, hx, hz, c: Math.cos(yaw), s: Math.sin(yaw), top, restitution, stamp: 0 });
  }

  private insert(col: Collider) {
    this.colliders.push(col);
    const x0 = Math.floor((col.x - col.r) / CELL), x1 = Math.floor((col.x + col.r) / CELL);
    const z0 = Math.floor((col.z - col.r) / CELL), z1 = Math.floor((col.z + col.r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        let cell = this.grid.get(k);
        if (!cell) this.grid.set(k, (cell = []));
        cell.push(col);
      }
    }
  }

  /** Fill `out` with colliders whose cells overlap the circle. Returns the count. */
  query(x: number, z: number, r: number, out: Collider[]): number {
    const stamp = ++this.stamp;
    let n = 0;
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = this.grid.get(key(cx, cz));
        if (!cell) continue;
        for (const col of cell) {
          if (col.stamp === stamp) continue;
          col.stamp = stamp;
          out[n++] = col;
        }
      }
    }
    return n;
  }
}

/** Circle vs collider. Writes the contact into `out` and returns true on overlap. */
export function circleVsCollider(x: number, z: number, r: number, col: Collider, out: Contact): boolean {
  const dx = x - col.x;
  const dz = z - col.z;
  if (col.shape === Shape.Circle) {
    const rr = r + col.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return false;
    const d = Math.sqrt(d2);
    if (d < 1e-6) {
      out.nx = 1;
      out.nz = 0;
    } else {
      out.nx = dx / d;
      out.nz = dz / d;
    }
    out.depth = rr - d;
    return true;
  }
  // Into box space: local X axis = (c, -s), local Z axis = (s, c).
  const { c, s, hx, hz } = col;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  if (Math.abs(lx) > hx + r || Math.abs(lz) > hz + r) return false;
  const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
  const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
  let nlx = lx - qx;
  let nlz = lz - qz;
  const d2 = nlx * nlx + nlz * nlz;
  if (d2 > 1e-10) {
    if (d2 >= r * r) return false;
    const d = Math.sqrt(d2);
    nlx /= d;
    nlz /= d;
    out.depth = r - d;
  } else {
    // Centre inside the box: push out along the shallowest axis.
    const px = hx - Math.abs(lx);
    const pz = hz - Math.abs(lz);
    if (px < pz) {
      nlx = lx < 0 ? -1 : 1;
      nlz = 0;
      out.depth = px + r;
    } else {
      nlx = 0;
      nlz = lz < 0 ? -1 : 1;
      out.depth = pz + r;
    }
  }
  // Back to world space.
  out.nx = nlx * c + nlz * s;
  out.nz = -nlx * s + nlz * c;
  return true;
}

/** A wedge you can drive up towards its local +X. Height rises linearly to `height` at the lip. */
export interface Ramp {
  x: number;
  z: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
  height: number;
}

export function rampHeight(ramps: Ramp[], x: number, z: number): number {
  let h = 0;
  for (const r of ramps) {
    const dx = x - r.x;
    const dz = z - r.z;
    const lx = dx * r.c - dz * r.s;
    const lz = dx * r.s + dz * r.c;
    if (lx < -r.hx || lx > r.hx || lz < -r.hz || lz > r.hz) continue;
    const y = ((lx + r.hx) / (2 * r.hx)) * r.height;
    if (y > h) h = y;
  }
  return h;
}
