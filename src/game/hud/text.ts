import * as THREE from 'three';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { Font } from 'three/addons/loaders/FontLoader.js';

export type { Font };

export async function loadFont(url: string): Promise<Font> {
  const json = await (await fetch(url)).json();
  return new Font(json);
}

/** Load the same font for canvas drawing (the manual's pages). Never throws. */
export async function loadCanvasFont(url: string, family: string) {
  try {
    const face = new FontFace(family, `url(${url})`);
    await face.load();
    document.fonts.add(face);
  } catch {
    // Falls back to the system font.
  }
}

export interface TextOpts {
  size: number;
  depth?: number;
  bevel?: number;
  align?: 'left' | 'center' | 'right';
}

const cache = new Map<string, THREE.BufferGeometry>();

/** Extruded text geometry, cached by content and style, aligned and vertically centred. */
export function textGeometry(font: Font, text: string, o: TextOpts): THREE.BufferGeometry {
  const key = `${text}|${o.size}|${o.depth}|${o.bevel}|${o.align}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bevel = o.bevel ?? o.size * 0.04;
  const geo = new TextGeometry(text, {
    font,
    size: o.size,
    depth: o.depth ?? o.size * 0.18,
    curveSegments: 3,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.7,
    bevelSegments: 2,
  });
  geo.computeBoundingBox();
  const b = geo.boundingBox!;
  const w = b.max.x - b.min.x;
  const dx = o.align === 'left' ? -b.min.x : o.align === 'right' ? -b.max.x : -b.min.x - w / 2;
  // Centre on cap height so mixed strings line up.
  geo.translate(dx, -o.size * 0.36, 0);
  geo.computeBoundingBox();
  cache.set(key, geo);
  return geo;
}

/** A text mesh whose string can be swapped cheaply (geometries are cached). */
export class Text3D extends THREE.Mesh {
  private current = '';
  constructor(
    private font: Font,
    material: THREE.Material,
    private opts: TextOpts,
    text = '',
  ) {
    super(new THREE.BufferGeometry(), material);
    this.set(text);
  }

  set(text: string) {
    if (text === this.current) return;
    this.current = text;
    this.geometry = text ? textGeometry(this.font, text, this.opts) : new THREE.BufferGeometry();
  }

  get width() {
    const b = this.geometry.boundingBox;
    return b ? b.max.x - b.min.x : 0;
  }
}

// ---- Seven-segment displays --------------------------------------------------

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc',
  '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '', r: 'eg', R: 'eg', n: 'ceg', N: 'abcef',
  P: 'abefg', E: 'adefg', A: 'abcefg', L: 'def', U: 'bcdef', H: 'bcefg',
};

/**
 * A seven-segment readout drawn as ONE InstancedMesh (one draw call). `pattern`
 * lays out the slots: '8' = digit, ':' = colon, '.' = dot, e.g. "8:88.88".
 * Segments switch by instance colour.
 */
export class SevenSegment {
  readonly mesh: THREE.InstancedMesh;
  readonly width: number;
  private slots: { kind: string; first: number }[] = [];
  private shown = '';

  constructor(
    pattern: string,
    height: number,
    private on: THREE.Color,
    private off: THREE.Color,
    material: THREE.Material,
  ) {
    const w = height * 0.56, t = height * 0.13, gap = height * 0.22, depth = height * 0.08;
    const mats: THREE.Matrix4[] = [];
    let x = 0;
    const slant = 0.1; // italic lean, for a bit of speed
    const seg = (cx: number, cy: number, sx: number, sy: number) => {
      const m = new THREE.Matrix4().makeScale(sx, sy, depth);
      m.setPosition(cx + cy * slant, cy, 0);
      mats.push(m);
    };
    for (const ch of pattern) {
      const first = mats.length;
      if (ch === '8') {
        const hx = x + w / 2, hh = height / 2, vy = height / 4;
        const hl = w - t * 1.1, vl = hh - t * 1.1;
        seg(hx, hh - t / 2, hl, t); // a
        seg(x + w - t / 2, vy, t, vl); // b
        seg(x + w - t / 2, -vy, t, vl); // c
        seg(hx, -hh + t / 2, hl, t); // d
        seg(x + t / 2, -vy, t, vl); // e
        seg(x + t / 2, vy, t, vl); // f
        seg(hx, 0, hl, t); // g
        x += w + gap;
      } else if (ch === ':') {
        seg(x + t / 2, height * 0.2, t, t);
        seg(x + t / 2, -height * 0.2, t, t);
        x += t + gap;
      } else {
        seg(x + t / 2, -height / 2 + t / 2, t, t);
        x += t + gap;
      }
      this.slots.push({ kind: ch, first });
    }
    this.width = x - gap;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, mats.length);
    mats.forEach((m, i) => {
      m.elements[12] -= this.width / 2;
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, off);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  /** Text must match the pattern's slots; separators in it are ignored (always lit). */
  set(text: string) {
    if (text === this.shown) return;
    this.shown = text;
    const order = 'abcdefg';
    let ti = 0;
    for (const slot of this.slots) {
      if (slot.kind === '8') {
        const ch = text[ti] ?? ' ';
        const lit = SEGMENTS[ch] ?? '';
        for (let k = 0; k < 7; k++) this.mesh.setColorAt(slot.first + k, lit.includes(order[k]) ? this.on : this.off);
      } else {
        const n = slot.kind === ':' ? 2 : 1;
        for (let k = 0; k < n; k++) this.mesh.setColorAt(slot.first + k, this.on);
      }
      ti++;
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }
}
