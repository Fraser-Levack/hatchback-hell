import * as THREE from 'three';
import type { Ramp, StaticWorld } from './collision';
import { mulberry32, yawFromDir } from './math';
import type { PropSystem } from './props';
import type { Terrain } from './terrain';
import { HALF_WIDTH, type Track } from './track';

export interface Layout {
  ramps: Ramp[];
  /** Sample index and lateral offset of the starting grid slot. */
  gridIndex: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const GANTRY_SCALE = 1.9;
const RAMP_SCALE = new THREE.Vector3(1.6, 1.5, 1.6);
const RAMP_AT = 60; // metres after the start line

interface Run {
  start: number;
  end: number;
  /** +1 = left-hand bend (outside is on the right). */
  dir: number;
  /** Tightest radius in the run. */
  minRadius: number;
}

/** Contiguous stretches where the bend radius is between `minRadius` and `maxRadius`. */
function findRuns(track: Track, maxRadius: number, minRadius = 0): Run[] {
  const n = track.n;
  const inRun = (i: number) => {
    const k = track.k[track.wrap(i)];
    const a = Math.abs(k);
    return a > 1 / maxRadius && (minRadius === 0 || a < 1 / minRadius) ? Math.sign(k) : 0;
  };
  // Start scanning from a sample that is not in a run so runs don't straddle the wrap.
  let origin = 0;
  while (inRun(origin) !== 0 && origin < n) origin++;
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let o = 0; o <= n; o++) {
    const i = origin + o;
    const d = o < n ? inRun(i) : 0;
    if (cur && d !== cur.dir) {
      runs.push(cur);
      cur = null;
    }
    if (!cur && d !== 0) cur = { start: i, end: i, dir: d, minRadius: Infinity };
    if (cur) {
      cur.end = i;
      cur.minRadius = Math.min(cur.minRadius, 1 / Math.abs(track.k[track.wrap(i)]));
    }
  }
  return runs.filter((r) => r.end - r.start >= 3);
}

/**
 * Walk a polyline and return evenly spaced chords of length `step`
 * (centre + direction), so models of that length tile it with no gaps.
 */
function chords(points: THREE.Vector3[], step: number) {
  const out: { x: number; z: number; yaw: number; pitch: number }[] = [];
  let a = points[0].clone();
  let seg = 1;
  while (seg < points.length) {
    // Find the point on the polyline at distance `step` from a.
    let b: THREE.Vector3 | null = null;
    for (; seg < points.length; seg++) {
      const p = points[seg];
      if (p.distanceTo(a) >= step) {
        const prev = points[seg - 1];
        // Binary search along prev->p for the exact crossing.
        let lo = 0, hi = 1;
        const tmp = new THREE.Vector3();
        for (let k = 0; k < 16; k++) {
          const mid = (lo + hi) / 2;
          tmp.lerpVectors(prev, p, mid);
          if (tmp.distanceTo(a) < step) lo = mid;
          else hi = mid;
        }
        b = tmp.lerpVectors(prev, p, hi).clone();
        break;
      }
    }
    if (!b) break;
    out.push({
      x: (a.x + b.x) / 2,
      z: (a.z + b.z) / 2,
      yaw: yawFromDir(b.x - a.x, b.z - a.z),
      pitch: Math.atan2(b.y - a.y, Math.hypot(b.x - a.x, b.z - a.z)),
    });
    a = b;
  }
  return out;
}

export function buildLayout(track: Track, props: PropSystem, world: StaticWorld, terrain: Terrain): Layout {
  const G = (x: number, z: number) => terrain.height(x, z);
  const rng = mulberry32(1337);
  const rand = (a: number, b: number) => a + (b - a) * rng();
  const ds = track.length / track.n;
  const idxAt = (metres: number) => track.wrap(Math.round(metres / ds));
  const p = new THREE.Vector3();
  const trackYaw = (i: number) => yawFromDir(track.tx[track.wrap(i)], track.tz[track.wrap(i)]);
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0);

  // ---- Start / finish gantry ------------------------------------------
  {
    const yaw = trackYaw(0);
    props.addStatic('start_finish_gantry', track.px[0], track.pz[0], yaw, GANTRY_SCALE);
    const pillar = 3.8 * GANTRY_SCALE;
    for (const side of [-1, 1]) {
      track.offsetPoint(0, side * pillar, p);
      world.addBox(p.x, p.z, 0.6, 0.6, yaw, p.y + 10);
    }
  }

  // ---- Jump ramps (two side by side) -----------------------------------
  const ramps: Ramp[] = [];
  {
    const i = idxAt(RAMP_AT);
    const yaw = trackYaw(i);
    const width = 1.8 * RAMP_SCALE.z;
    for (const side of [-0.5, 0.5]) {
      track.offsetPoint(i, side * width, p);
      props.addStatic('jump_ramp', p.x, p.z, yaw, RAMP_SCALE);
    }
    ramps.push({
      x: track.px[i], z: track.pz[i], c: Math.cos(yaw), s: Math.sin(yaw),
      hx: 2 * RAMP_SCALE.x, hz: width, height: 0.8 * RAMP_SCALE.y,
    });
    // Warning cones either side of the run-up.
    for (const side of [-1, 1]) {
      for (const back of [5, 9]) {
        track.offsetPoint(i - back, side * (width + 0.9), p);
        props.addDynamic('traffic_cone', p.x, p.z, rand(0, 6));
      }
    }
  }

  // ---- Corners: barriers, tyre walls, chevrons, apex cones -------------
  const corners = findRuns(track, 55);
  // Samples claimed by corner furniture, so other things don't overlap it.
  const claimed = new Uint8Array(track.n);
  for (const run of corners) for (let i = run.start - 10; i <= run.end + 24; i++) claimed[track.wrap(i)] = 1;

  for (const run of corners) {
    const outside = run.dir; // right side (+lateral) is the outside of a left bend
    const from = run.start - 6, to = run.end + 12;

    // Concrete barrier chain on the outside.
    const off = outside * (HALF_WIDTH + 3.4);
    const line: THREE.Vector3[] = [];
    for (let i = from; i <= to; i++) line.push(track.offsetPoint(i, off, new THREE.Vector3()));
    const barriers = chords(line, 3);
    for (const b of barriers) {
      props.addStatic('jersey_barrier', b.x, b.z, b.yaw, 1, undefined, b.pitch);
      world.addBox(b.x, b.z, 1.5, 0.32, b.yaw, G(b.x, b.z) + 0.8 + Math.abs(b.pitch) * 1.5, 0.2);
    }

    // Tyres in front of the exposed upstream end of the barrier chain.
    if (barriers.length) {
      const first = barriers[0];
      const fx = Math.cos(first.yaw), fz = -Math.sin(first.yaw);
      for (let k = 0; k < 3; k++) {
        const x = first.x - fx * (2.0 + k * 0.65), z = first.z - fz * (2.0 + k * 0.65);
        props.addDynamic('tyre_stack', x, z, rand(0, 6));
      }
    }

    // The tightest bends get a tyre wall in front of the barriers.
    if (run.minRadius < 20) {
      const wall: THREE.Vector3[] = [];
      for (let i = run.start - 2; i <= run.end + 6; i++) {
        wall.push(track.offsetPoint(i, outside * (HALF_WIDTH + 2.4), new THREE.Vector3()));
      }
      for (const t of chords(wall, 0.7)) props.addDynamic('tyre_stack', t.x, t.z, rand(0, 6));
    }

    // Chevron signs behind the barriers, facing the oncoming driver.
    const len = run.end - run.start;
    for (let k = 0; k < 3; k++) {
      const i = run.start + Math.round((len * (k + 0.5)) / 3);
      track.offsetPoint(i, outside * (HALF_WIDTH + 5.6), p);
      const yaw = yawFromDir(-track.tx[track.wrap(i)], -track.tz[track.wrap(i)]);
      // Arrows point to the driver's right; mirror them for a left-hand bend.
      const s = 1.5;
      p.y = G(p.x, p.z);
      mat.compose(p, q.setFromAxisAngle(Y, yaw), new THREE.Vector3(s, s, run.dir > 0 ? -s : s));
      if (run.dir > 0) props.addMesh('chevron_sign', mat);
      else props.addStatic('chevron_sign', p.x, p.z, yaw, s);
    }

    // Cones on the inside kerb at the apex.
    for (let i = run.start + 2; i <= run.end - 1; i += 4) {
      track.offsetPoint(i, -outside * (HALF_WIDTH + 0.6), p);
      props.addDynamic('traffic_cone', p.x, p.z, rand(0, 6));
    }

    // A pile of crates and drums on the outside of the exit, waiting to be hit.
    const exit = run.end + 18;
    const base = track.offsetPoint(exit, outside * (HALF_WIDTH + 2.2), new THREE.Vector3());
    const ex = track.tx[track.wrap(exit)], ez = track.tz[track.wrap(exit)];
    const crates = rng() < 0.5;
    for (let k = 0; k < 5; k++) {
      const along = (k % 3) * 1.0 + rand(-0.15, 0.15);
      const across = Math.floor(k / 3) * 1.0 * outside;
      const x = base.x + ex * along - ez * across;
      const z = base.z + ez * along + ex * across;
      props.addDynamic(crates ? 'wooden_crate' : 'oil_drum', x, z, rand(0, 6));
    }
  }

  // ---- Hay bales along the faster sweepers -----------------------------
  for (const run of findRuns(track, 140, 55)) {
    if (run.end - run.start < 8) continue;
    const outside = run.dir;
    // Split into stretches that stay clear of the corner furniture.
    const lines: THREE.Vector3[][] = [[]];
    for (let i = run.start; i <= run.end; i++) {
      if (claimed[track.wrap(i)]) {
        if (lines[lines.length - 1].length) lines.push([]);
        continue;
      }
      lines[lines.length - 1].push(track.offsetPoint(i, outside * (HALF_WIDTH + 2.8), new THREE.Vector3()));
    }
    for (const line of lines) {
      if (line.length < 4) continue;
      // Bale axis is local Z, so turn them 90 degrees to line up along the road.
      for (const c of chords(line, 4.5)) props.addDynamic('hay_bale', c.x, c.z, c.yaw + Math.PI / 2);
    }
  }

  // ---- Main straight: lamps and fences ---------------------------------
  {
    const startS = -105, endS = 92;
    for (let sDist = startS; sDist <= endS; sDist += 22) {
      const i = idxAt(sDist);
      if (Math.abs(sDist - RAMP_AT) < 6) continue;
      for (const side of [-1, 1]) {
        track.offsetPoint(i, side * (HALF_WIDTH + 3.0), p);
        // The lamp head hangs over local +X, so point +X back at the road.
        const yaw = yawFromDir(track.tz[i] * side, -track.tx[i] * side);
        props.addStatic('street_lamp', p.x, p.z, yaw);
        world.addCircle(p.x, p.z, 0.22, G(p.x, p.z) + 6, 0.15);
      }
    }
    for (const side of [-1, 1]) {
      const line: THREE.Vector3[] = [];
      for (let sDist = startS - 8; sDist <= endS + 8; sDist += 2) {
        line.push(track.offsetPoint(idxAt(sDist), side * (HALF_WIDTH + 6), new THREE.Vector3()));
      }
      for (const f of chords(line, 4)) {
        props.addStatic('fence', f.x, f.z, f.yaw, 1, undefined, f.pitch);
        world.addBox(f.x, f.z, 2, 0.12, f.yaw, G(f.x, f.z) + 1.2, 0.2);
      }
    }
  }

  // ---- A few cone lines across the road to plough through ---------------
  for (const at of [0.3, 0.52, 0.78]) {
    const i = idxAt(track.length * at);
    const side = rng() < 0.5 ? -1 : 1;
    for (let k = 0; k < 4; k++) {
      track.offsetPoint(i, side * (1 + k * 1.4), p);
      props.addDynamic('traffic_cone', p.x, p.z, rand(0, 6));
    }
  }

  // ---- Scenery ---------------------------------------------------------
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < track.n; i++) {
    minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
    minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
  }
  const margin = 200;
  const bounds = { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
  const distToTrack = (x: number, z: number) => {
    const i = track.nearest(x, z);
    return Math.hypot(track.px[i] - x, track.pz[i] - z);
  };
  const taken: { x: number; z: number; r: number }[] = [];
  const free = (x: number, z: number, r: number) => taken.every((t) => (t.x - x) ** 2 + (t.z - z) ** 2 > (t.r + r) ** 2);

  const scatter = (count: number, minDist: number, maxDist: number, r: number, fn: (x: number, z: number) => void) => {
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 40; tries++) {
      const x = rand(bounds.minX, bounds.maxX);
      const z = rand(bounds.minZ, bounds.maxZ);
      const d = distToTrack(x, z);
      if (d < minDist || d > maxDist || !free(x, z, r)) continue;
      taken.push({ x, z, r });
      fn(x, z);
      placed++;
    }
  };
  // Keep the jump's landing zone and the area around the gantry clear.
  taken.push({ x: track.px[idxAt(RAMP_AT + 30)], z: track.pz[idxAt(RAMP_AT + 30)], r: 30 });

  scatter(260, HALF_WIDTH + 12, 190, 3.5, (x, z) => {
    const s = rand(0.8, 1.35);
    const y = G(x, z) - 0.15;
    props.addStatic(rng() < 0.6 ? 'pine_tree' : 'oak_tree', x, z, rand(0, Math.PI * 2), s, y);
    world.addCircle(x, z, 0.32 * s, y + 20, 0.1);
  });
  scatter(26, HALF_WIDTH + 10, 60, 2.2, (x, z) => {
    const s = rand(0.7, 1.4);
    props.addStatic('boulder', x, z, rand(0, Math.PI * 2), s, G(x, z) - 0.2);
    world.addCircle(x, z, 0.72 * s, G(x, z) + 0.9 * s, 0.3);
  });
  scatter(110, HALF_WIDTH + 7.5, 90, 1.6, (x, z) => props.addStatic('bush', x, z, rand(0, Math.PI * 2), rand(0.7, 1.3), G(x, z) - 0.1));
  scatter(60, HALF_WIDTH + 7, 80, 0.8, (x, z) => props.addStatic('rock_small', x, z, rand(0, Math.PI * 2), rand(0.6, 1.4), G(x, z) - 0.1));

  // ---- World edges -------------------------------------------------------
  const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
  const hw = (bounds.maxX - bounds.minX) / 2, hd = (bounds.maxZ - bounds.minZ) / 2;
  world.addBox(cx, bounds.minZ - 5, hw + 10, 5, 0, 500);
  world.addBox(cx, bounds.maxZ + 5, hw + 10, 5, 0, 500);
  world.addBox(bounds.minX - 5, cz, 5, hd + 10, 0, 500);
  world.addBox(bounds.maxX + 5, cz, 5, hd + 10, 0, 500);

  return { ramps, gridIndex: track.wrap(-Math.round(16 / ds)), bounds };
}
