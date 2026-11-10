import * as THREE from 'three';
import { UNIT, type ModelLibrary } from '../assets';
import type { Car } from '../car';
import type { HudMaterials } from './materials';
import { Text3D, type Font } from './text';

/**
 * A miniature of the player's car on a turntable. Each frame it copies the
 * real car's part transforms, so lost parts vanish and loose ones hang off,
 * with an integrity bar and a parts-lost counter.
 */
export class DamageModel {
  readonly group = new THREE.Group();
  private turntable = new THREE.Group();
  private parts = new Map<string, THREE.Group>();
  private fill: THREE.Mesh;
  private fillMat: THREE.MeshStandardMaterial;
  private barWidth: number;
  private label: Text3D;
  private flash: THREE.PointLight;
  private lastIntegrity = 1;
  private spin = 0;

  constructor(lib: ModelLibrary, font: Font, M: HudMaterials, size: number) {
    // Own copies of the car's materials: sharing them with the main scene (other
    // lights, fog) would make three.js swap shader programs every frame.
    const mats = new Map<THREE.Material, THREE.Material>();
    const own = (m: THREE.Material) => {
      let c = mats.get(m);
      if (!c) mats.set(m, (c = m.clone()));
      return c;
    };
    const carScale = size / 4.2;
    const car = new THREE.Group();
    car.scale.setScalar(carScale);
    for (const def of lib.values()) {
      const pivot = new THREE.Vector3().fromArray(def.extras.pivot as number[]).multiplyScalar(UNIT);
      const offset = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
      const g = new THREE.Group();
      for (const p of def.pieces) {
        const mesh = new THREE.Mesh(p.geometry, own(p.material));
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(p.matrix).premultiply(offset);
        g.add(mesh);
      }
      g.position.copy(pivot);
      if (def.name.startsWith('wheel')) g.rotation.order = 'YXZ';
      car.add(g);
      this.parts.set(def.name, g);
    }

    const disc = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.62, size * 0.66, size * 0.06, 48), M.gunmetal);
    disc.position.y = -size * 0.03;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(size * 0.64, size * 0.012, 8, 64), M.chrome);
    rim.rotation.x = Math.PI / 2;
    this.turntable.add(disc, rim, car);
    this.turntable.rotation.x = 0.42;
    this.group.add(this.turntable);

    // A red light that flashes on the model when the car takes a hit.
    this.flash = new THREE.PointLight('#ff3020', 0, size * 2.5, 1.5);
    this.flash.position.set(0, size * 0.5, size * 0.6);
    this.group.add(this.flash);

    // Integrity bar.
    this.barWidth = size * 1.25;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(this.barWidth + size * 0.05, size * 0.09, size * 0.04), M.gunmetal);
    frame.position.set(0, -size * 0.5, 0);
    this.fillMat = new THREE.MeshStandardMaterial({ color: '#4ade80', emissive: '#22c55e', emissiveIntensity: 0.6, roughness: 0.4 });
    const fillGeo = new THREE.BoxGeometry(1, size * 0.055, size * 0.05).translate(0.5, 0, 0);
    this.fill = new THREE.Mesh(fillGeo, this.fillMat);
    this.fill.position.set(-this.barWidth / 2, -size * 0.5, size * 0.01);
    this.fill.scale.x = this.barWidth;
    this.label = new Text3D(font, M.white, { size: size * 0.085, depth: size * 0.015, bevel: 0 }, '');
    this.label.position.set(0, -size * 0.66, size * 0.02);
    const plaque = new THREE.Mesh(new THREE.BoxGeometry(size * 1.3, size * 0.17, size * 0.03), M.gunmetal);
    plaque.position.set(0, -size * 0.66, -size * 0.01);
    this.group.add(frame, this.fill, plaque, this.label);
  }

  update(dt: number, car: Car) {
    for (const p of car.parts) {
      const g = this.parts.get(p.name);
      if (!g) continue;
      g.visible = p.attached;
      if (p.attached) {
        g.position.copy(p.group.position);
        g.quaternion.copy(p.group.quaternion);
      }
    }
    this.spin += dt * 0.45;
    this.turntable.rotation.y = this.spin;

    const integrity = car.integrity;
    if (integrity < this.lastIntegrity - 0.002) this.flash.intensity = 6;
    this.lastIntegrity = integrity;
    this.flash.intensity *= Math.exp(-5 * dt);

    this.fill.scale.x = Math.max(0.0001, this.barWidth * integrity);
    const c = integrity > 0.6 ? '#4ade80' : integrity > 0.3 ? '#facc15' : '#ef4444';
    this.fillMat.color.set(c);
    this.fillMat.emissive.set(c);
    this.label.set(`PARTS LOST ${car.partsLost}/${car.detachableCount}`);
  }
}
