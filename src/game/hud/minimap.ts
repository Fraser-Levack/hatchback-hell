import * as THREE from 'three';
import type { Terrain } from '../terrain';
import { HALF_WIDTH, type Track } from '../track';
import type { HudMaterials } from './materials';

const CONTOUR = 2; // metres between contour lines
const EXAGGERATE = 3.2;

/**
 * A little scale model of the circuit: the real heightmap with hypsometric
 * colour bands and contour lines, on a wooden plinth, with the track as a
 * raised ribbon and a marker for the car.
 */
export class TopoMap {
  readonly group = new THREE.Group();
  private model = new THREE.Group();
  private marker = new THREE.Group();
  private scale: number;
  private ox: number;
  private oz: number;
  private minH: number;
  private bob = 0;

  constructor(
    private track: Track,
    private terrain: Terrain,
    M: HudMaterials,
    width: number,
  ) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < track.n; i++) {
      minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
      minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
    }
    const pad = 32;
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
    this.scale = width / (maxX - minX);
    this.ox = (minX + maxX) / 2;
    this.oz = (minZ + maxZ) / 2;
    const nx = 96, nz = Math.round((nx * (maxZ - minZ)) / (maxX - minX));

    // Heights over the area.
    const heights = new Float32Array((nx + 1) * (nz + 1));
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const h = terrain.height(minX + ((maxX - minX) * i) / nx, minZ + ((maxZ - minZ) * j) / nz);
        heights[j * (nx + 1) + i] = h;
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    }
    this.minH = lo;
    const base = -0.04;

    // Terrain surface. `elev` carries real metres for the contour shader.
    const pos: number[] = [], elev: number[] = [], idx: number[] = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const x = minX + ((maxX - minX) * i) / nx, z = minZ + ((maxZ - minZ) * j) / nz;
        const h = heights[j * (nx + 1) + i];
        pos.push(...this.toLocal(x, h, z));
        elev.push(h);
        if (i < nx && j < nz) {
          const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('elev', new THREE.Float32BufferAttribute(elev, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const surface = new THREE.Mesh(geo, topoMaterial(lo, hi));
    this.model.add(surface);

    // Skirt down to the plinth on all four sides, so it reads as a solid block.
    const skirt: number[] = [];
    const edge = (i: number, j: number) => {
      const x = minX + ((maxX - minX) * i) / nx, z = minZ + ((maxZ - minZ) * j) / nz;
      return [this.toLocal(x, heights[j * (nx + 1) + i], z), this.toLocal(x, lo, z)] as const;
    };
    const wall = (pts: (readonly [number[], number[]])[], flip: boolean) => {
      for (let k = 0; k < pts.length - 1; k++) {
        const [t0, b0] = pts[k], [t1, b1] = pts[k + 1];
        b0[1] = b1[1] = base;
        const tri = flip ? [t0, t1, b0, b0, t1, b1] : [t0, b0, t1, b0, b1, t1];
        for (const v of tri) skirt.push(...v);
      }
    };
    wall(Array.from({ length: nx + 1 }, (_, i) => edge(i, nz)), false);
    wall(Array.from({ length: nx + 1 }, (_, i) => edge(i, 0)), true);
    wall(Array.from({ length: nz + 1 }, (_, j) => edge(0, j)), false);
    wall(Array.from({ length: nz + 1 }, (_, j) => edge(nx, j)), true);
    const skirtGeo = new THREE.BufferGeometry();
    skirtGeo.setAttribute('position', new THREE.Float32BufferAttribute(skirt, 3));
    skirtGeo.computeVertexNormals();
    const soil = new THREE.MeshStandardMaterial({ color: '#7a5a3a', roughness: 0.9, side: THREE.DoubleSide });
    this.model.add(new THREE.Mesh(skirtGeo, soil));

    // Plinth.
    const w = (maxX - minX) * this.scale, d = (maxZ - minZ) * this.scale;
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(w * 1.06, width * 0.06, d * 1.08), M.wood);
    plinth.position.y = base - width * 0.03;
    this.model.add(plinth);

    // Track ribbon (drawn wider than scale, so it reads at this size).
    const tpos: number[] = [], tidx: number[] = [];
    const half = Math.max(HALF_WIDTH, 7);
    for (let i = 0; i <= track.n; i++) {
      const k = i % track.n;
      for (const lat of [-half, half]) {
        const x = track.px[k] - track.tz[k] * lat, z = track.pz[k] + track.tx[k] * lat;
        tpos.push(...this.toLocal(x, track.py[k] + 1.2, z));
      }
      if (i < track.n) {
        const a = i * 2;
        tidx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.Float32BufferAttribute(tpos, 3));
    tgeo.setIndex(tidx);
    tgeo.computeVertexNormals();
    this.model.add(new THREE.Mesh(tgeo, new THREE.MeshStandardMaterial({ color: '#26282c', roughness: 0.6, side: THREE.DoubleSide })));

    // Start line flag.
    const flag = new THREE.Mesh(new THREE.BoxGeometry(width * 0.008, width * 0.05, width * 0.008), M.white);
    const [fx, fy, fz] = this.toLocal(track.px[0], track.py[0], track.pz[0]);
    flag.position.set(fx, fy + width * 0.025, fz);
    this.model.add(flag);

    // Car marker: a red arrowhead on a pin.
    const cone = new THREE.Mesh(new THREE.ConeGeometry(width * 0.022, width * 0.06, 12), M.red);
    cone.rotation.z = -Math.PI / 2; // point along +X
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(width * 0.003, width * 0.003, width * 0.05, 6), M.white);
    pin.position.y = -width * 0.025;
    const head = new THREE.Group();
    head.add(cone);
    head.position.y = width * 0.05;
    this.marker.add(head, pin);
    this.marker.position.y = 0;
    this.model.add(this.marker);

    // Lean the model back towards the viewer.
    this.model.rotation.x = 0.95;
    this.group.add(this.model);
  }

  private toLocal(x: number, h: number, z: number): number[] {
    return [(x - this.ox) * this.scale, (h - (this.minH ?? 0)) * this.scale * EXAGGERATE, (z - this.oz) * this.scale];
  }

  update(dt: number, x: number, z: number, heading: number) {
    this.bob += dt * 3;
    const [lx, ly, lz] = this.toLocal(x, this.terrain.height(x, z), z);
    this.marker.position.set(lx, ly + Math.sin(this.bob) * 0.01, lz);
    this.marker.rotation.y = heading;
  }
}

function topoMaterial(lo: number, hi: number) {
  return new THREE.ShaderMaterial({
    uniforms: {
      lo: { value: lo },
      hi: { value: hi },
      step: { value: CONTOUR },
      light: { value: new THREE.Vector3(-0.4, 0.8, 0.5).normalize() },
    },
    vertexShader: /* glsl */ `
      attribute float elev;
      varying float vElev;
      varying vec3 vNormal;
      void main() {
        vElev = elev;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float lo; uniform float hi; uniform float step; uniform vec3 light;
      varying float vElev;
      varying vec3 vNormal;
      vec3 ramp(float t) {
        // Hypsometric tints: valley green -> grass -> khaki -> brown -> pale peak.
        vec3 a = vec3(0.13, 0.36, 0.17), b = vec3(0.36, 0.58, 0.25), c = vec3(0.74, 0.70, 0.42);
        vec3 d = vec3(0.55, 0.38, 0.22), e = vec3(0.92, 0.90, 0.86);
        if (t < 0.25) return mix(a, b, t / 0.25);
        if (t < 0.5) return mix(b, c, (t - 0.25) / 0.25);
        if (t < 0.8) return mix(c, d, (t - 0.5) / 0.3);
        return mix(d, e, (t - 0.8) / 0.2);
      }
      void main() {
        float band = floor(vElev / step) * step;
        vec3 col = ramp(clamp((band - lo) / max(hi - lo, 1.0), 0.0, 1.0));
        // Contour lines a constant pixel width, every 5th one heavier.
        float f = vElev / step;
        float w = fwidth(f);
        float line = 1.0 - smoothstep(0.0, w * 1.2, abs(fract(f - 0.5) - 0.5));
        float major = 1.0 - smoothstep(0.0, w * 1.8, abs(fract(f / 5.0 - 0.5) - 0.5) * 5.0);
        col *= 1.0 - 0.35 * max(line, major);
        float diff = 0.55 + 0.6 * max(dot(normalize(vNormal), light), 0.0);
        gl_FragColor = vec4(col * diff, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}
