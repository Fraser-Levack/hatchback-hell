# Racing game scenery

Static props to go with the breakable hatchback, at the same scale.

| Folder | Contents |
|---|---|
| `glb/` | The models for three.js |
| `irsm/` | Their IronSmith sources (hand-written, commented) |
| `previews/` | A render of each model |
| `build.py` | Re-exports `glb/` from `irsm/` (and optionally re-renders `previews/`) |

## Conventions (same as the hatchback)

- **Units:** 1 unit = 10 cm. Scale by `0.1` for metres, the same as the car's root.
- **Y is up.** Every model stands on y = 0, centred on its base, so
  `mesh.position.set(x, 0, z)` puts it on the ground.
- **Direction:** a model with a front or a direction faces **+X**, like the car.

## Models

| Model | Size (L x H x W, units) | Notes |
|---|---|---|
| `traffic_cone` | 4.4 x 7 x 4.4 | Orange with reflective bands |
| `tyre_stack` | 6.2 x 6 x 6.2 | Three tyres, same size as the car's wheels |
| `jersey_barrier` | 30 x 8 x 6 | Concrete, red/white stripe. Lay them end to end every 30 units along X |
| `hay_bale` | 13 x 13 x 12 | Round bale on its side, axis along Z |
| `oil_drum` | 6 x 9 x 6 | Blue 200 L drum |
| `wooden_crate` | 8 x 8 x 8 | |
| `jump_ramp` | 40 x 8 x 18 | Drive up it towards +X |
| `fence` | 40 x 12 x 1.7 | Post-and-rail section, tiles every 40 units along X |
| `chevron_sign` | 1 x 12 x 14 | Bend warning, faces +X, arrows point to -Z. Rotate 180 degrees about Y for the other direction |
| `street_lamp` | 13 x 58 x 3 | The light hangs over +X, so point +X at the road. The lamp is emissive |
| `start_finish_gantry` | 6 x 50 x 82 | Spans the road (the road runs along X), 70 units between the pillars. Red start lights are emissive |
| `pine_tree` | 29 x 61 x 29 | |
| `oak_tree` | 34 x 48 x 30 | |
| `bush` | 18 x 9 x 17 | |
| `boulder` | 17.5 x 10 x 13.5 | |
| `rock_small` | 8 x 4.3 x 7 | |

For comparison, the hatchback is 40 x 15 x 17.5.

## Physics

The meshes are dense: 25k to 190k triangles each, 28 MB in total. Don't use
them as collision meshes. A box, cylinder or capsule per prop is plenty:
the sizes are in the table above, and the cone, drum, tyre stack and bale
are cylinders. Physics engines can build a convex hull from the mesh too,
if you need one.

For lighter files, lower a model's resolution in `build.py` (file size goes
with its square), or simplify the meshes with glTF-Transform:
`npx @gltf-transform/cli optimize in.glb out.glb --simplify-error 0.001`.

## Re-exporting

```
python build.py                # all models
python build.py cone ramp      # only names containing "cone" or "ramp"
python build.py --previews     # also re-render previews/
```

Set `IRONSMITH` to the `ironsmith` binary if the one on `PATH` is older than
the exporter that fits the grid to each model; older versions clip anything
more than 2.5 m from the origin.
