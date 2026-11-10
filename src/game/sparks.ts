import * as THREE from 'three';
import { GRAVITY, type GroundFn } from './rigidbody';

const MAX = 600;

/** Pooled additive spark particles: one draw call, one small buffer upload per frame. */
export class Sparks {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private col = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private next = 0;
  private live = 0;

  constructor(private ground: GroundFn) {
    const geo = new THREE.BufferGeometry();
    this.pos.fill(-1000);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.14,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(x: number, y: number, z: number, count: number, speed: number, vx = 0, vz = 0) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3] = vx * 0.6 + Math.cos(a) * s;
      this.vel[i * 3 + 1] = Math.random() * speed * 0.6 + 0.5;
      this.vel[i * 3 + 2] = vz * 0.6 + Math.sin(a) * s;
      this.life[i] = 0.25 + Math.random() * 0.45;
    }
    this.live = Math.min(MAX, this.live + count);
  }

  update(dt: number) {
    if (this.live === 0) return;
    let alive = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.pos[j + 1] = -1000;
        this.col[j] = this.col[j + 1] = this.col[j + 2] = 0;
        continue;
      }
      alive++;
      this.vel[j + 1] -= GRAVITY * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      const floor = this.ground(this.pos[j], this.pos[j + 2]) + 0.02;
      if (this.pos[j + 1] < floor) {
        this.pos[j + 1] = floor;
        this.vel[j + 1] *= -0.3;
      }
      const t = Math.min(this.life[i] * 2.5, 1);
      this.col[j] = 3 * t;
      this.col[j + 1] = 1.6 * t * t;
      this.col[j + 2] = 0.4 * t * t * t;
    }
    this.live = alive;
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}
