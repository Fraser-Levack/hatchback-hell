import * as THREE from 'three';
import { clamp } from './math';
import { HALF_WIDTH, type Track } from './track';

const CELL = 3.5;
const MARGIN = 380;
/** The ground is exactly road height out to here (m from the centreline)... */
const FLAT = HALF_WIDTH + 4.5;
/** ...and fully natural from here. In between it's an embankment. */
const BLEND = HALF_WIDTH + 30;

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Rolling hills as a heightmap. The track's elevation is the natural terrain
 * smoothed along the lap, and the ground near the road is flattened to it.
 * The same grid drives both the mesh and `height()`, so what you see is what
 * the physics drives on.
 */
export class Terrain {
  readonly minX: number;
  readonly minZ: number;
  readonly nx: number;
  readonly nz: number;
  readonly h: Float32Array;
  /** Distance to the track centreline at each grid point (for colouring). */
  private dist: Float32Array;
  readonly centre: THREE.Vector2;
  readonly mesh: THREE.Mesh;

  constructor(private track: Track) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
      minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
    }
    this.centre = new THREE.Vector2((minX + maxX) / 2, (minZ + maxZ) / 2);
    this.minX = minX - MARGIN;
    this.minZ = minZ - MARGIN;
    this.nx = Math.ceil((maxX - minX + MARGIN * 2) / CELL) + 1;
    this.nz = Math.ceil((maxZ - minZ + MARGIN * 2) / CELL) + 1;
    this.h = new Float32Array(this.nx * this.nz);
    this.dist = new Float32Array(this.nx * this.nz);

    this.roadHeights();
    this.buildGrid();
    this.mesh = this.buildMesh();
  }

  /** The landscape before the road is cut into it. */
  natural(x: number, z: number) {
    // Keep the main straight (start line, gantry, jump) flat and level.
    const dx = x < -125 ? x + 125 : x > 115 ? x - 115 : 0;
    const flat = smoothstep(20, 170, Math.hypot(dx, z));
    const hills =
      16 * Math.sin(x * 0.012 + 0.7) * Math.cos(z * 0.015 - 0.4) +
      9 * Math.sin(x * 0.021 + z * 0.016 + 1.9) +
      3.5 * Math.sin(x * 0.047 - z * 0.038 + 0.5);
    // A ring of bigger hills around the edge of the map closes the world in.
    const r = Math.hypot(x - this.centre.x, (z - this.centre.y) * 1.25);
    const rim = smoothstep(230, 520, r) * 60 + smoothstep(190, 300, r) * 6;
    const bumps = smoothstep(220, 400, r) * 8 * Math.sin(x * 0.03) * Math.sin(z * 0.034);
    return hills * flat + rim + bumps;
  }

  /** Road elevation per track sample: the natural height, heavily smoothed along the lap. */
  private roadHeights() {
    const t = this.track, n = t.n;
    let a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = this.natural(t.px[i], t.pz[i]);
    // Gaussian blur, sigma ~ 24 m, applied twice.
    const sigma = 11, R = 33;
    const w: number[] = [];
    let wsum = 0;
    for (let o = -R; o <= R; o++) { const v = Math.exp(-(o * o) / (2 * sigma * sigma)); w.push(v); wsum += v; }
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let o = -R; o <= R; o++) s += a[(i + o + n) % n] * w[o + R];
        b[i] = s / wsum;
      }
      [a, b] = [b, a];
    }
    t.py.set(a);
  }

  private buildGrid() {
    const t = this.track;
    // Bucket the samples so each grid point only looks at nearby road.
    const B = 32;
    const buckets = new Map<number, number[]>();
    const bkey = (bx: number, bz: number) => bx * 10007 + bz;
    for (let i = 0; i < t.n; i++) {
      const k = bkey(Math.floor(t.px[i] / B), Math.floor(t.pz[i] / B));
      let list = buckets.get(k);
      if (!list) buckets.set(k, (list = []));
      list.push(i);
    }
    const reach = Math.ceil(BLEND / B);
    for (let j = 0; j < this.nz; j++) {
      const z = this.minZ + j * CELL;
      for (let i = 0; i < this.nx; i++) {
        const x = this.minX + i * CELL;
        const nat = this.natural(x, z);
        // Nearest sample overall, and the nearest on a *different* stretch of track.
        let i1 = -1, d1 = Infinity, i2 = -1, d2best = Infinity;
        const bx = Math.floor(x / B), bz = Math.floor(z / B);
        for (let ox = -reach; ox <= reach; ox++) {
          for (let oz = -reach; oz <= reach; oz++) {
            const list = buckets.get(bkey(bx + ox, bz + oz));
            if (!list) continue;
            for (const s of list) {
              const dx = t.px[s] - x, dz = t.pz[s] - z;
              const d2 = dx * dx + dz * dz;
              if (d2 < d1) { d1 = d2; i1 = s; }
            }
          }
        }
        const idx = j * this.nx + i;
        if (i1 < 0 || d1 > BLEND * BLEND) {
          this.dist[idx] = BLEND;
          this.h[idx] = nat;
          continue;
        }
        for (let ox = -reach; ox <= reach; ox++) {
          for (let oz = -reach; oz <= reach; oz++) {
            const list = buckets.get(bkey(bx + ox, bz + oz));
            if (!list) continue;
            for (const s of list) {
              const gap = Math.abs(s - i1);
              if (Math.min(gap, t.n - gap) < 30) continue;
              const dx = t.px[s] - x, dz = t.pz[s] - z;
              const d2 = dx * dx + dz * dz;
              if (d2 < d2best) { d2best = d2; i2 = s; }
            }
          }
        }
        const dist1 = Math.sqrt(d1);
        this.dist[idx] = dist1;
        let road = this.roadHeightNear(i1, x, z);
        let f = 1 - smoothstep(FLAT, BLEND, dist1);
        if (i2 >= 0 && d2best < BLEND * BLEND) {
          // Two stretches of road nearby: blend their heights so the ground between has no seam.
          const dist2 = Math.sqrt(d2best);
          const w1 = Math.exp(-(dist1 * dist1) / 128), w2 = Math.exp(-(dist2 * dist2) / 128);
          const road2 = this.roadHeightNear(i2, x, z);
          road = (road * w1 + road2 * w2) / (w1 + w2);
          f = Math.max(f, 1 - smoothstep(FLAT, BLEND, dist2));
        }
        this.h[idx] = nat + (road - nat) * f;
      }
    }
  }

  /** Road height at the point on the centreline nearest (x, z), interpolated between samples. */
  private roadHeightNear(i: number, x: number, z: number) {
    const t = this.track;
    const along = (x - t.px[i]) * t.tx[i] + (z - t.pz[i]) * t.tz[i];
    const ds = t.length / t.n;
    const j = along >= 0 ? t.wrap(i + 1) : t.wrap(i - 1);
    const u = Math.min(Math.abs(along) / ds, 1);
    return t.py[i] + (t.py[j] - t.py[i]) * u;
  }

  /** Bilinear height at (x, z). */
  height(x: number, z: number) {
    let fx = (x - this.minX) / CELL;
    let fz = (z - this.minZ) / CELL;
    fx = clamp(fx, 0, this.nx - 1.001);
    fz = clamp(fz, 0, this.nz - 1.001);
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i0 = iz * this.nx + ix;
    const h = this.h;
    const a = h[i0] + (h[i0 + 1] - h[i0]) * tx;
    const b = h[i0 + this.nx] + (h[i0 + this.nx + 1] - h[i0 + this.nx]) * tx;
    return a + (b - a) * tz;
  }

  private buildMesh() {
    const { nx, nz } = this;
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    const grassA = new THREE.Color('#5c9a43');
    const grassB = new THREE.Color('#477f34');
    const dry = new THREE.Color('#8f9a52');
    const rock = new THREE.Color('#7f7b6c');
    const forest = new THREE.Color('#355f2c');
    const c = new THREE.Color();
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const x = this.minX + i * CELL, z = this.minZ + j * CELL;
        const y = this.h[idx];
        pos.set([x, y, z], idx * 3);
        // Slope from neighbours.
        const hx = this.h[j * nx + Math.min(i + 1, nx - 1)] - this.h[j * nx + Math.max(i - 1, 0)];
        const hz = this.h[Math.min(j + 1, nz - 1) * nx + i] - this.h[Math.max(j - 1, 0) * nx + i];
        const slope = Math.hypot(hx, hz) / (2 * CELL);
        const t = 0.5 + 0.25 * Math.sin(x * 0.045 + Math.sin(z * 0.03) * 2) + 0.25 * Math.sin(z * 0.07 - x * 0.02);
        c.copy(grassA).lerp(grassB, t);
        // Sun-dried tops, darker woods up on the rim, rock on steep banks.
        c.lerp(dry, smoothstep(6, 14, y) * 0.35);
        c.lerp(forest, smoothstep(25, 55, y) * 0.7);
        c.lerp(rock, smoothstep(0.35, 0.7, slope) * 0.8);
        // Worn, dusty grass right by the track.
        c.lerp(dry, (1 - smoothstep(HALF_WIDTH + 3, HALF_WIDTH + 9, this.dist[idx])) * 0.25);
        col.set([c.r, c.g, c.b], idx * 3);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, cc = a + nx, d = cc + 1;
        idx.push(a, cc, b, b, cc, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'terrain';
    return mesh;
  }
}
