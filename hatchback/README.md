# Breakable hatchback

A small 3-door hot hatch built from 23 separate parts, made for a racing game
where bumping into things knocks bits off.

| File | What it is |
|---|---|
| `hatchback.irsm` / `hatchback.glb` | The whole car in one model (for previews) |
| `parts/*.irsm` | One script per part, drawn around the part's own pivot |
| `glb/*.glb` | The parts exported for three.js |
| `manifest.json` | Each part's file, pivot, category and a suggested mass |
| `build_hatchback.py` | Generates all of the above. **Edit this file, not the `.irsm` files.** |
| `glb_weld.py` | Shares vertices and adds an index buffer to a GLB (lossless, about 4x smaller) |

```
python build_hatchback.py                    # regenerate the .irsm files + manifest
python build_hatchback.py --export           # ...and export + weld every GLB (needs numpy)
python build_hatchback.py --export --res 128 # more detail, bigger files
```

## Parts

| Category | Parts |
|---|---|
| core | `body`, which never falls off |
| panel | `bonnet`, `door_left`, `door_right`, `tailgate` (with its rear glass) |
| glass | `windscreen` |
| bumper | `bumper_front`, `bumper_rear` |
| light | `headlight_left/right`, `taillight_left/right` (`neon` material, so emissive in glTF) |
| trim | `grille`, `mirror_left/right`, `spoiler`, `exhaust`, `plate_front`, `plate_rear` |
| wheel | `wheel_front_left/right`, `wheel_rear_left/right` |

Each panel is cut from the same body surface it fits into, so the car has no
gaps when it is assembled. Where a part comes off, the body shows a dark recess,
not a hole into empty space.

## Conventions

- **Units:** 1 unit = 10 cm, so the car is 40 x 17.5 x 15 units. Scale the
  car's root by `0.1` to work in metres. The car is modelled large on purpose:
  the exporter's sampling grid gives small parts like mirrors and plates more
  detail at that size.
- **Axes:** front faces **+X**, Y is up, and the tyres touch y = 0.
- **Pivots:** every part GLB is centred on its own pivot. Setting
  `mesh.position` to the part's `pivot` puts it back in place on the car. A
  part that breaks off spins about its own centre, and each wheel's pivot is
  its axle, so wheels can spin on their local Z axis.

## three.js

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const base = 'models/hatchback/';
const manifest = await (await fetch(base + 'manifest.json')).json();
const loader = new GLTFLoader();

const car = new THREE.Group();
car.scale.setScalar(0.1);          // units -> metres
car.rotation.y = Math.PI / 2;      // model +X forward -> three.js -Z forward
scene.add(car);

const parts = {};
await Promise.all(manifest.parts.map(async (p) => {
  const gltf = await loader.loadAsync(base + p.file);
  const obj = gltf.scene;
  obj.position.fromArray(p.pivot);
  obj.userData = { ...p, attached: true };
  car.add(obj);
  parts[p.name] = obj;
}));

// Knock a part off: move it into world space while keeping its transform,
// then let your physics (or a simple velocity) take over.
function detach(name, impulse) {
  const part = parts[name];
  if (!part?.userData.attached || !part.userData.detachable) return;
  part.userData.attached = false;
  scene.attach(part);              // keeps its world position, rotation and scale
  part.userData.velocity = impulse.clone();
  part.userData.spin = new THREE.Vector3().randomDirection().multiplyScalar(4);
}
```

For impacts, take the hit point in car-local space (`car.worldToLocal(p)`)
and detach the attached parts whose pivot is nearest, or give each part a hit
counter and detach it after N hits. Wheels count as `detachable`; leave them
out of the candidates if you don't want cars losing wheels.

The headlights and taillights use an emissive material, so they glow in
three.js without a light. Add some scene lights for everything else, and an
environment map if you want the chrome on the exhaust and grille to reflect
something.

## Making the files smaller

The exporter makes evenly sized triangles even on flat panels, so the meshes
are dense. At the default `--res 96` a panel is 30-45k triangles and a wheel
about 80k, which comes to roughly 1M triangles and 17 MB for the whole car.
That's fine for one prototype car on a desktop GPU. For several cars, or the
web, export at a lower `--res` (64 halves the count), and simplify the meshes,
for example with
[glTF-Transform](https://gltf-transform.dev):
`npx @gltf-transform/cli optimize in.glb out.glb --simplify-error 0.001`.
