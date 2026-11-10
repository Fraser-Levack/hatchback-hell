import * as THREE from 'three';

/** Centreline control points (x, z) in metres. Driven in this order. */
const CONTROL_POINTS: [number, number][] = [
  [0, 0], [100, 0], [155, -8], [185, -45], [188, -100], [168, -138], [130, -142],
  [112, -112], [105, -75], [70, -52], [25, -68], [-5, -115], [-45, -148], [-100, -150],
  [-142, -122], [-162, -75], [-145, -35], [-110, -8], [-55, 0],
];

export const ROAD_WIDTH = 12;
export const HALF_WIDTH = ROAD_WIDTH / 2;
const SPACING = 2;

/**
 * The circuit, sampled every ~2 m along its centreline. All queries work on
 * the samples, so there is no spline maths at runtime.
 */
export class Track {
  readonly n: number;
  readonly length: number;
  readonly px: Float32Array;
  readonly pz: Float32Array;
  /** Unit tangent. The right-hand side is (-tz, tx). */
  readonly tx: Float32Array;
  readonly tz: Float32Array;
  /** Arc length from the start line. */
  readonly s: Float32Array;
  /** Signed curvature (1 / radius). Positive = left-hand bend. */
  readonly k: Float32Array;
  /** Road elevation, filled in by the Terrain. */
  readonly py: Float32Array;

  constructor() {
    const curve = new THREE.CatmullRomCurve3(
      CONTROL_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    );
    this.length = curve.getLength();
    const n = (this.n = Math.round(this.length / SPACING));
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);
    this.s = new Float32Array(n);
    this.k = new Float32Array(n);
    this.py = new Float32Array(n);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const u = i / n;
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t);
      t.y = 0;
      t.normalize();
      this.px[i] = p.x;
      this.pz[i] = p.z;
      this.tx[i] = t.x;
      this.tz[i] = t.z;
      this.s[i] = u * this.length;
    }
    const ds = this.length / n;
    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // Turning from +X towards -Z is a left turn, which gives a negative cross product.
      const cross = this.tx[i] * this.tz[j] - this.tz[i] * this.tx[j];
      raw[i] = -Math.asin(Math.max(-1, Math.min(1, cross))) / ds;
    }
    // Smooth over ~10 m so placement decisions aren't noisy.
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let o = -2; o <= 2; o++) sum += raw[(i + o + n) % n];
      this.k[i] = sum / 5;
    }
  }

  wrap(i: number) {
    return ((i % this.n) + this.n) % this.n;
  }

  /** Nearest sample index. With a hint, only searches near it (cheap per-frame tracking). */
  nearest(x: number, z: number, hint = -1): number {
    let best = 0;
    let bestD = Infinity;
    if (hint < 0) {
      for (let i = 0; i < this.n; i++) {
        const dx = this.px[i] - x, dz = this.pz[i] - z;
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }
    for (let o = -20; o <= 20; o++) {
      const i = this.wrap(hint + o);
      const dx = this.px[i] - x, dz = this.pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    // Lost track (teleport, huge jump): fall back to a full search.
    return bestD > 900 ? this.nearest(x, z) : best;
  }

  /** Signed distance from the centreline at sample i. Positive = right of the direction of travel. */
  lateral(i: number, x: number, z: number) {
    return (x - this.px[i]) * -this.tz[i] + (z - this.pz[i]) * this.tx[i];
  }

  /** World position (on the road surface) at sample i, offset sideways by `lat` (positive = right). */
  offsetPoint(i: number, lat: number, out: THREE.Vector3) {
    i = this.wrap(i);
    return out.set(this.px[i] - this.tz[i] * lat, this.py[i], this.pz[i] + this.tx[i] * lat);
  }
}

// ---------------------------------------------------------------------------
// Meshes

function asphaltTexture(): THREE.CanvasTexture {
  // 12 m across x 24 m along: 256 x 512 px is ~21 px per metre each way.
  const w = 256, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#3b3d40';
  g.fillRect(0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (rnd() - 0.5) * 12;
    img.data[i] += v;
    img.data[i + 1] += v;
    img.data[i + 2] += v;
  }
  g.putImageData(img, 0, 0);
  // Darker racing line in the middle, worn by tyres.
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.35, 'rgba(0,0,0,0.10)');
  grad.addColorStop(0.65, 'rgba(0,0,0,0.10)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Edge lines (0.25 m wide, 0.35 m in) and a dashed centre line.
  g.fillStyle = '#e9e9e4';
  const px = w / ROAD_WIDTH;
  g.fillRect(0.35 * px, 0, 0.25 * px, h);
  g.fillRect(w - 0.6 * px, 0, 0.25 * px, h);
  const dash = h / 4;
  for (let y = 0; y < h; y += dash) g.fillRect(w / 2 - 0.08 * px, y, 0.16 * px, dash * 0.5);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** A strip along the track between two lateral offsets. */
function ribbon(track: Track, inner: number, outer: number, y: number, vRepeat: number) {
  const n = track.n;
  const pos = new Float32Array((n + 1) * 2 * 3);
  const uv = new Float32Array((n + 1) * 2 * 2);
  const idx: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const j = i % n;
    const v = (i === n ? track.length : track.s[j]) / vRepeat;
    track.offsetPoint(j, inner, p);
    pos.set([p.x, p.y + y, p.z], i * 6);
    track.offsetPoint(j, outer, p);
    pos.set([p.x, p.y + y, p.z], i * 6 + 3);
    uv.set([0, v, 1, v], i * 4);
    if (i < n) {
      const a = i * 2;
      // Inner -> outer runs to the right of travel, so this winding faces up (+Y).
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Road surfaces sit a few cm above the terrain; polygon offset keeps them on top at a distance. */
const onTop = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };

/** Red/white kerbs on both sides wherever the bend is tighter than `minRadius`. */
function kerbs(track: Track, minRadius: number) {
  const pos: number[] = [];
  const col: number[] = [];
  // THREE.Color parses hex as sRGB and stores linear, which is what vertex colours want.
  const red = new THREE.Color('#c8161d');
  const white = new THREE.Color('#f0f0f0');
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3();
  const n = track.n;
  const tight = (i: number) => Math.abs(track.k[track.wrap(i)]) > 1 / minRadius;
  for (let i = 0; i < n; i++) {
    // Extend each kerb a few samples either side of the tight part.
    let on = false;
    for (let o = -4; o <= 4 && !on; o++) on = tight(i + o);
    if (!on) continue;
    const color = (i >> 1) % 2 === 0 ? red : white;
    for (const side of [-1, 1]) {
      const inner = side * HALF_WIDTH;
      const outer = side * (HALF_WIDTH + 1.1);
      track.offsetPoint(i, inner, a);
      track.offsetPoint(i, outer, b);
      track.offsetPoint(i + 1, inner, c);
      track.offsetPoint(i + 1, outer, d);
      const quad = side > 0 ? [a, b, c, b, d, c] : [a, c, b, b, c, d];
      for (const v of quad) {
        pos.push(v.x, v.y + 0.1, v.z);
        col.push(color.r, color.g, color.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function startLine(track: Track) {
  const pos: number[] = [];
  const col: number[] = [];
  const cols = 12, rows = 2, size = ROAD_WIDTH / cols;
  const fx = track.tx[0], fz = track.tz[0];
  const rx = -fz, rz = fx;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const black = (r + c) % 2 === 0;
      const v = black ? 0.01 : 0.8;
      const l0 = -HALF_WIDTH + c * size, l1 = l0 + size;
      const f0 = (r - rows / 2) * size, f1 = f0 + size;
      const P = (l: number, f: number) => [track.px[0] + rx * l + fx * f, track.py[0] + 0.11, track.pz[0] + rz * l + fz * f];
      for (const [l, f] of [[l0, f0], [l1, f0], [l1, f1], [l0, f0], [l1, f1], [l0, f1]]) {
        pos.push(...P(l, f));
        col.push(v, v, v);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

export function buildTrackMeshes(track: Track): THREE.Group {
  const group = new THREE.Group();
  group.name = 'track';

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, receive = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = receive;
    m.matrixAutoUpdate = false;
    group.add(m);
    return m;
  };

  // Road. Texture length 24 m; make it divide the lap evenly so the seam is invisible.
  const texLen = track.length / Math.round(track.length / 24);
  // Road surfaces float a few cm over the terrain to cover its interpolation error.
  const road = ribbon(track, -HALF_WIDTH, HALF_WIDTH, 0.09, texLen);
  add(road, new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.92, metalness: 0, ...onTop }));

  // Dusty verges either side.
  const vergeMat = new THREE.MeshLambertMaterial({ color: '#7b7356', ...onTop });
  add(ribbon(track, HALF_WIDTH, HALF_WIDTH + 2.6, 0.08, 10), vergeMat);
  add(ribbon(track, -HALF_WIDTH - 2.6, -HALF_WIDTH, 0.08, 10), vergeMat);

  add(kerbs(track, 70), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, ...onTop }));
  add(startLine(track), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, ...onTop }));

  return group;
}
