import * as THREE from 'three';
import { damp } from '../math';

export const CANVAS_FONT = 'HudFont';
const HEAD = `"${CANVAS_FONT}", "Arial Black", sans-serif`;
const BODY = `ui-sans-serif, system-ui, "Segoe UI", sans-serif`;

const CONTROLS: [string, string][] = [
  ['W / ↑', 'Accelerate'],
  ['S / ↓', 'Brake, then reverse'],
  ['A D / ← →', 'Steer'],
  ['Space', 'Handbrake (drift)'],
  ['E / Q', 'Shift up / down (manual)'],
  ['T', 'Automatic ↔ manual gears'],
  ['R', 'Back on the track'],
  ['Enter', 'Restart & repair'],
  ['C', 'Change camera'],
  ['M', 'Crash cam on / off'],
  ['H', 'This manual (pauses)'],
];

const NOTES = [
  'Every knock costs bodywork. Lights, mirrors and plates go first; panels next; wheels last.',
  'Loose parts flap and hang before they fall. Hit them again and they’re gone.',
  'Lose a wheel and that corner drags: sparks, a lean, and a pull to that side.',
  'Big hits roll the slow-mo crash cam. Control returns when the replay ends.',
  'Crests throw you skywards above ~170 km/h. Land straight.',
  'Shift light on the rev counter: change up when it glows.',
  'A lap counts once you pass both checkpoints and cross the line.',
];

function paper(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = '#f5f0e2';
  g.fillRect(0, 0, w, h);
  // Faint ruled lines and a little grain.
  g.strokeStyle = 'rgba(80, 110, 160, 0.13)';
  g.lineWidth = 2;
  for (let y = 150; y < h - 40; y += 44) {
    g.beginPath();
    g.moveTo(40, y);
    g.lineTo(w - 40, y);
    g.stroke();
  }
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() - 0.5) * 10;
    img.data[i] += v; img.data[i + 1] += v; img.data[i + 2] += v;
  }
  g.putImageData(img, 0, 0);
}

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) {
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y);
      line = word;
      y += lh;
    } else line = test;
  }
  g.fillText(line, x, y);
  return y + lh;
}

function pageTexture(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) {
  const w = 768, h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  paper(g, w, h);
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function leftPage() {
  return pageTexture((g, w, h) => {
    g.fillStyle = '#c8161d';
    g.font = `52px ${HEAD}`;
    g.fillText('CONTROLS', 56, 110);
    g.font = `26px ${BODY}`;
    g.fillStyle = '#555';
    g.fillText('Keyboard (gamepad also works)', 58, 146);
    let y = 214;
    for (const [key, what] of CONTROLS) {
      g.font = `30px ${HEAD}`;
      g.fillStyle = '#1b1d22';
      // Key cap.
      const kw = g.measureText(key).width + 26;
      g.fillStyle = '#e4ddcb';
      g.strokeStyle = '#8a8270';
      g.lineWidth = 2;
      g.beginPath();
      g.roundRect(56, y - 32, kw, 44, 8);
      g.fill();
      g.stroke();
      g.fillStyle = '#1b1d22';
      g.fillText(key, 69, y);
      g.font = `30px ${BODY}`;
      g.fillStyle = '#2a2c31';
      g.fillText(what, 300, y);
      y += 68;
    }
    g.font = `22px ${BODY}`;
    g.fillStyle = '#888';
    g.fillText('– 2 –', w / 2 - 22, h - 40);
  });
}

function rightPage() {
  return pageTexture((g, w, h) => {
    g.fillStyle = '#c8161d';
    g.font = `52px ${HEAD}`;
    g.fillText('DRIVING NOTES', 56, 110);
    let y = 200;
    for (const note of NOTES) {
      g.fillStyle = '#c8161d';
      g.beginPath();
      g.arc(70, y - 10, 7, 0, Math.PI * 2);
      g.fill();
      g.font = `29px ${BODY}`;
      g.fillStyle = '#2a2c31';
      y = wrap(g, note, 92, y, w - 150, 40) + 22;
    }
    g.fillStyle = '#1b1d22';
    g.font = `34px ${HEAD}`;
    const msg = 'PRESS  H  OR  ENTER  TO  DRIVE';
    g.fillText(msg, (w - g.measureText(msg).width) / 2, h - 100);
    g.font = `22px ${BODY}`;
    g.fillStyle = '#888';
    g.fillText('– 3 –', w / 2 - 22, h - 40);
  });
}

function coverTexture() {
  const w = 768, h = 1024;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#d11f26');
  grad.addColorStop(1, '#8e0f14');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Racing stripes.
  g.fillStyle = 'rgba(255,255,255,0.9)';
  g.fillRect(w * 0.62, 0, 46, h);
  g.fillRect(w * 0.62 + 64, 0, 18, h);
  g.fillStyle = '#fff';
  g.font = `40px ${HEAD}`;
  g.fillText("OWNER'S", 60, 200);
  g.fillText('MANUAL', 60, 248);
  g.font = `92px ${HEAD}`;
  g.fillText('HATCHBACK', 52, 470);
  g.fillText('HELL', 52, 570);
  g.font = `28px ${BODY}`;
  g.fillStyle = 'rgba(255,255,255,0.8)';
  g.fillText('Model HH-1 · 3-door · 6-speed', 60, 640);
  g.fillText('Keep in glovebox. Glovebox not included.', 60, h - 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A hardback owner's manual. Open: it sits centre-screen showing the controls
 * and notes (the game is paused). Closed: it shrinks to a small book in the
 * corner of the screen.
 */
export class ManualBook {
  readonly group = new THREE.Group();
  /** Darkens the game behind the open book. */
  readonly backdrop: THREE.Mesh;
  private leaf = new THREE.Group();
  private open = 1;
  private target = 1;
  private openPose = { pos: new THREE.Vector3(), scale: 1 };
  private closedPose = { pos: new THREE.Vector3(), scale: 0.3 };
  private backdropMat: THREE.MeshBasicMaterial;

  constructor(pageH: number) {
    const H = pageH, W = H * 0.75, T = H * 0.05;
    const coverMat = new THREE.MeshStandardMaterial({ color: '#b3141a', roughness: 0.55 });
    const edgeMat = new THREE.MeshStandardMaterial({ color: '#efe8d4', roughness: 0.9 });

    // Right half: back cover + page block + page 3. Stays put.
    const back = new THREE.Mesh(new THREE.BoxGeometry(W * 1.03, H * 1.04, T * 0.35), coverMat);
    back.position.set(W / 2, 0, -T * 1.2);
    const blockR = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), edgeMat);
    blockR.position.set(W / 2, 0, -T / 2);
    const pageR = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.98, H * 0.98), new THREE.MeshStandardMaterial({ map: rightPage(), roughness: 0.9 }));
    pageR.position.set(W / 2, 0, 0.002);
    this.group.add(back, blockR, pageR);

    // Left leaf: page 2 + page block + front cover, hinged on the spine (x = 0).
    const blockL = new THREE.Mesh(new THREE.BoxGeometry(W, H, T), edgeMat);
    blockL.position.set(-W / 2, 0, -T / 2);
    const pageL = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.98, H * 0.98), new THREE.MeshStandardMaterial({ map: leftPage(), roughness: 0.9 }));
    pageL.position.set(-W / 2, 0, 0.002);
    const front = new THREE.Mesh(new THREE.BoxGeometry(W * 1.03, H * 1.04, T * 0.35), coverMat);
    front.position.set(-W / 2, 0, -T * 1.2);
    const art = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.0, H * 1.0), new THREE.MeshStandardMaterial({ map: coverTexture(), roughness: 0.5 }));
    // Faces backwards while open, so it's the right way round once the leaf swings shut.
    art.rotation.y = Math.PI;
    art.position.set(-W / 2, 0, -T * 1.4 - 0.002);
    this.leaf.add(blockL, pageL, front, art);
    this.group.add(this.leaf);

    // Spine.
    const spine = new THREE.Mesh(new THREE.CylinderGeometry(T * 1.2, T * 1.2, H * 1.04, 16, 1, false, Math.PI, Math.PI), coverMat);
    spine.position.z = -T * 0.6;
    this.group.add(spine);

    this.backdropMat = new THREE.MeshBasicMaterial({ color: '#05070a', transparent: true, opacity: 0.6, depthWrite: false, depthTest: false });
    this.backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.backdropMat);
    this.backdrop.renderOrder = -5;
  }

  get isOpen() {
    return this.target === 1;
  }

  setOpen(open: boolean) {
    this.target = open ? 1 : 0;
  }

  /** Where the book sits open (screen centre) and closed (a corner). */
  layout(open: THREE.Vector3, closed: THREE.Vector3, closedScale: number, viewW: number, viewH: number) {
    this.openPose.pos.copy(open);
    this.closedPose.pos.copy(closed);
    this.closedPose.scale = closedScale;
    this.backdrop.scale.set(viewW, viewH, 1);
  }

  update(dt: number) {
    this.open += (this.target - this.open) * damp(5, dt);
    const t = this.open;
    const e = t * t * (3 - 2 * t);
    // The cover swings open a beat after the book arrives, and shuts before it leaves.
    const swing = Math.min(1, Math.max(0, (t - 0.35) / 0.65));
    this.leaf.rotation.y = -Math.PI * (1 - swing * swing * (3 - 2 * swing));
    this.group.position.lerpVectors(this.closedPose.pos, this.openPose.pos, e);
    this.group.scale.setScalar(this.closedPose.scale + (1 - this.closedPose.scale) * e);
    // Closed: tilted, at rest. Open: facing you, with a slight lean.
    this.group.rotation.set(-0.18 * e - 0.35 * (1 - e), 0.35 * (1 - e), 0.12 * (1 - e));
    this.backdropMat.opacity = 0.62 * e;
    this.backdrop.visible = e > 0.01;
  }
}
