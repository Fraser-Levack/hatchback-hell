import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** Source models use 1 unit = 10 cm. The game works in metres. */
export const UNIT = 0.1;

/** One primitive of a model: draw `geometry` with `material`, transformed by `matrix`. */
export interface Piece {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Geometry space -> model space, in metres. */
  matrix: THREE.Matrix4;
}

export interface ModelDef {
  name: string;
  pieces: Piece[];
  /** Model-space bounds in metres. */
  box: THREE.Box3;
  extras: Record<string, unknown>;
}

export type ModelLibrary = Map<string, ModelDef>;

const materials = new Map<string, THREE.Material>();

/**
 * The car and props share material names (e.g. "plastic #c8161d"), so one
 * material per name across both files means fewer program/state switches.
 */
function shareMaterial(m: THREE.Material): THREE.Material {
  const key = m.name || m.uuid;
  const existing = materials.get(key);
  if (existing) {
    if (existing !== m) m.dispose();
    return existing;
  }
  const std = m as THREE.MeshStandardMaterial;
  if (std.isMeshStandardMaterial) {
    if (key.startsWith('neon')) {
      if (std.emissive.getHex() === 0) std.emissive.copy(std.color);
      std.emissiveIntensity = 1.6;
    } else if (key.startsWith('metal')) {
      std.metalness = 1;
      std.roughness = Math.min(std.roughness, 0.35);
    } else if (key.startsWith('plastic')) {
      std.envMapIntensity = 0.45;
    } else {
      std.envMapIntensity = 0.35;
    }
  }
  materials.set(key, m);
  return m;
}

export function getSharedMaterial(name: string) {
  return materials.get(name);
}

let loader: GLTFLoader | null = null;

export async function loadModels(url: string, onProgress?: (p: number) => void): Promise<ModelLibrary> {
  loader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (e) => {
    if (onProgress && e.total) onProgress(e.loaded / e.total);
  });
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const toMetres = new THREE.Matrix4().makeScale(UNIT, UNIT, UNIT);
  const lib: ModelLibrary = new Map();
  const tmpBox = new THREE.Box3();

  for (const node of root.children) {
    const pieces: Piece[] = [];
    const box = new THREE.Box3();
    node.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const matrix = toMetres.clone().multiply(mesh.matrixWorld);
      const geometry = mesh.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (!geometry.boundingSphere) geometry.computeBoundingSphere();
      box.union(tmpBox.copy(geometry.boundingBox!).applyMatrix4(matrix));
      pieces.push({ geometry, material: shareMaterial(mesh.material as THREE.Material), matrix });
    });
    lib.set(node.name, { name: node.name, pieces, box, extras: { ...node.userData } });
  }
  return lib;
}

/**
 * Build a plain (non-instanced) object for a model. `offset` is applied in
 * model space before the pieces, e.g. to re-centre a car part on its pivot.
 */
export function instantiate(def: ModelDef, offset?: THREE.Matrix4, shadows = true): THREE.Group {
  const group = new THREE.Group();
  group.name = def.name;
  for (const p of def.pieces) {
    const mesh = new THREE.Mesh(p.geometry, p.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(p.matrix);
    if (offset) mesh.matrix.premultiply(offset);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
  }
  return group;
}
