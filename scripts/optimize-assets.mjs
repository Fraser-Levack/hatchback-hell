// Builds the game-ready models in public/models from the source GLBs.
//
//   hatchback/glb/*.glb + manifest.json  ->  public/models/car.glb
//   game_assets/glb/*.glb                ->  public/models/props.glb
//
// The source meshes are very dense (marching-tetrahedra output), so each one
// is welded, simplified with meshoptimizer, deduplicated, quantised and
// meshopt-compressed. Everything is packed into two files, so the game makes
// two requests instead of 39.
//
// car.glb has one root node per part, named after it, positioned at its
// manifest pivot, with { pivot, category, detachable, mass } in its extras.
// (Quantisation moves the node transform, so read the pivot from extras.)
// So the file loads as an assembled car.
//
// props.glb has one root node per prop, named after the source file, at the
// origin.
//
//   npm run assets
//   npm run assets -- --error 0.002   (more aggressive simplification)

import { readFileSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  flatten,
  meshopt,
  mergeDocuments,
  prune,
  simplify,
  weld,
} from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models');
mkdirSync(outDir, { recursive: true });

const argError = process.argv.indexOf('--error');
const ERROR = argError > 0 ? Number(process.argv[argError + 1]) : 0.0012;

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

function triangleCount(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return tris;
}

/** Read one source GLB and simplify it with its own error budget. */
async function readSimplified(entry) {
  const doc = await io.read(entry.file);
  const before = triangleCount(doc);
  await doc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio: 0, error: entry.error, lockBorder: false }),
  );
  return { doc, before, after: triangleCount(doc) };
}

/**
 * Merge several single-model GLBs into one document with one scene, one root
 * node per input. `entries` is [{ name, file, error, translation?, extras? }].
 */
async function pack(entries) {
  const loaded = await Promise.all(entries.map(readSimplified));
  const target = loaded[0].doc;
  const scene = target.getRoot().getDefaultScene() ?? target.getRoot().listScenes()[0];

  const nameRoot = (sceneLike, entry) => {
    const roots = sceneLike.listChildren();
    if (roots.length !== 1) throw new Error(`${entry.file}: expected one root node`);
    const node = roots[0];
    node.setName(entry.name);
    if (entry.translation) node.setTranslation(entry.translation);
    if (entry.extras) node.setExtras(entry.extras);
    return node;
  };
  nameRoot(scene, entries[0]);

  for (let i = 1; i < entries.length; i++) {
    const src = loaded[i].doc;
    const map = mergeDocuments(target, src);
    const merged = map.get(src.getRoot().listScenes()[0]);
    const node = nameRoot(merged, entries[i]);
    merged.removeChild(node);
    scene.addChild(node);
    merged.dispose();
  }
  // mergeDocuments leaves one buffer per input; one is enough.
  const buffers = target.getRoot().listBuffers();
  for (const accessor of target.getRoot().listAccessors()) accessor.setBuffer(buffers[0]);
  for (const b of buffers.slice(1)) b.dispose();

  for (let i = 0; i < entries.length; i++) {
    const { before, after } = loaded[i];
    console.log(`  ${entries[i].name.padEnd(20)} ${String(before).padStart(7)} -> ${after} tris`);
  }
  const before = loaded.reduce((a, l) => a + l.before, 0);
  return { doc: target, before };
}

async function write({ doc, before }, outFile) {
  await doc.transform(
    dedup(),
    flatten(),
    prune({ keepLeaves: true, keepAttributes: false }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(outFile, doc);
  const after = triangleCount(doc);
  const kb = (statSync(outFile).size / 1024).toFixed(0);
  console.log(
    `${basename(outFile)}: ${before.toLocaleString()} -> ${after.toLocaleString()} triangles, ${kb} KB
`,
  );
}

// ---- Car ---------------------------------------------------------------
const carDir = join(root, 'hatchback');
const manifest = JSON.parse(readFileSync(join(carDir, 'manifest.json'), 'utf8'));
const carDoc = await pack(
  manifest.parts.map((p) => ({
    name: p.name,
    file: join(carDir, p.file),
    translation: p.pivot,
    error: ERROR,
    extras: { pivot: p.pivot, category: p.category, detachable: p.detachable, mass: p.mass_kg },
  })),
);
await write(carDoc, join(outDir, 'car.glb'));

// ---- Props -------------------------------------------------------------
// Props are instanced many times, so the busiest ones get a coarser budget.
// Multipliers on the base error; anything not listed uses 1.5x.
const PROP_ERROR = {
  tyre_stack: 8,
  wooden_crate: 4,
  hay_bale: 4,
  oil_drum: 3,
  traffic_cone: 3,
  pine_tree: 3,
  oak_tree: 3,
  bush: 3,
  chevron_sign: 3,
  // The chequered banner's edges go jagged if simplified hard.
  start_finish_gantry: 0.4,
};
const propDir = join(root, 'game_assets', 'glb');
const propDoc = await pack(
  readdirSync(propDir)
    .filter((f) => f.endsWith('.glb'))
    .sort()
    .map((f) => {
      const name = basename(f, '.glb');
      return { name, file: join(propDir, f), error: ERROR * (PROP_ERROR[name] ?? 1.5) };
    }),
);
await write(propDoc, join(outDir, 'props.glb'));
