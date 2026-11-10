# Hatchback Hell

A tiny racing game: one hot hatch, one circuit, and every bump knocks a bit of
the car off. Next.js + React + TypeScript + three.js (via React Three Fiber).

```
npm install
npm run dev        # http://localhost:3000
npm run build && npm start
```

## Controls

| Key | |
|---|---|
| W A S D / arrows | Drive (S brakes, then reverses) |
| Space | Handbrake (drift) |
| R | Put the car back on the track (keeps the damage) |
| Enter | Restart: repair the car, reset the props, new countdown |
| E / Q | Shift up / down (manual gearbox) |
| T | Toggle automatic / manual gearbox |
| C | Cycle camera: chase / far chase / bonnet |
| M | Crash cam (slow-mo replays) on/off |
| H | Owner's manual (pauses the game) |

The manual opens on load; close it (H or Enter) to start the countdown. Hold
W on the grid to rev the engine.

A gamepad works too (right trigger throttle, left trigger brake, stick steers,
A/B handbrake, Y recover, Start restart, X camera).

Add `?debug` to the URL to get the engine as `window.hh` in the console.

## Assets

The source models stay where they are (`hatchback/`, `game_assets/`).
`npm run assets` builds the two files the game loads:

| Output | From | Triangles | Size |
|---|---|---|---|
| `public/models/car.glb` | 23 parts in `hatchback/glb` + `manifest.json` | 840k → 52k | 17 MB → 316 KB |
| `public/models/props.glb` | 16 models in `game_assets/glb` | 1.17M → 41k | 28 MB → 411 KB |

The script (`scripts/optimize-assets.mjs`) welds and simplifies each mesh with
meshoptimizer, packs them into one file per set, dedups materials, and
quantises + meshopt-compresses the result. In `car.glb` each part is a root
node named after it, with `{ pivot, category, detachable, mass }` in its
extras. Read the pivot from the extras: quantisation moves the node transform.
Per-prop simplification budgets are at the bottom of the script. Re-run it
after you change any source GLB.

## Font

The 3D HUD text uses Russo One (SIL Open Font License, `assets/fonts/OFL.txt`).
`npm run font` converts it to three.js typeface JSON (printable ASCII only,
27 KB) and copies the TTF for the manual's canvas pages, both into
`public/fonts/`. 3D text can only use those ASCII characters.

## Code map (`src/game`)

| File | |
|---|---|
| `engine.ts` | Owns everything: lights/sky, fixed 120 Hz simulation, laps, HUD feed |
| `car.ts` | Arcade handling, collisions, damage, loose/hinged parts, wheel loss |
| `debris.ts` | Detached parts as rigid bodies (they tumble, roll, and can be kicked) |
| `rigidbody.ts` | Tiny rigid body vs ground plane using hull points |
| `props.ts` | Instanced scenery (chunked for culling) + knockable props |
| `layout.ts` | Where everything goes, generated from the track's curvature |
| `track.ts` | Centreline spline, sampling/queries, road/kerb meshes |
| `terrain.ts` | Hills heightmap: road elevation, embankments, ground mesh + `height()` |
| `sky.ts` | Cloud/sun sky shader and the distant mountain rings |
| `collision.ts` | Circle/box colliders in a spatial hash, ramp heights |
| `camera.ts` | Chase cam, and the cinematic orbit cam used for slow-mo crashes |
| `sparks.ts`, `input.ts` | Pooled spark particles, keyboard/gamepad |
| `GameCanvas.tsx` | R3F canvas, asset/font loading, drives `engine.update()` + `engine.render()` |
| `hud/hud3d.ts` | The 3D HUD scene: layout, countdown, toasts, wrong way, letterbox, vignette |
| `hud/gauges.ts` | Speedometer, rev counter (gear LED, shift light) and the stopwatch |
| `hud/minimap.ts` | Topographic scale model of the terrain with the track and car marker |
| `hud/damage.ts` | Miniature of the car on a turntable mirroring the real one's damage |
| `hud/manual.ts` | The owner's manual book (canvas-printed pages) |
| `hud/text.ts` | Cached extruded text, and instanced seven-segment displays |

To change the circuit, edit `CONTROL_POINTS` in `track.ts`. Barriers, tyre
walls, chevrons, cones, hay bales and scenery are all placed from the track's
curvature, so they follow the new layout automatically.

### Hills

`Terrain.natural()` is the landscape: a few overlapping sine waves, kept flat
around the main straight, plus a ring of big hills at the map edge. The road's
elevation is that landscape sampled along the lap and Gaussian-smoothed, and
the ground within ~10 m of the road is set to exactly the road height, then
blended back to the natural shape by ~36 m (embankments). Physics, props,
debris, sparks and the camera all read the same `terrain.height(x, z)`.

The car is always ballistic; the ground only stops it sinking. Over a crest
the ground falls away faster than gravity, so you take off. Slopes also push
the car along via gravity.

### Slow-mo crash cam

When a part comes off from a hard hit (or a heavy part: bumpers, panels,
glass, wheels), time drops to 12%, the camera cuts to an orbit around that
part, and you lose control for 2.4 real seconds. Then it eases back to the
chase cam. There is a 3.5 s cooldown. The constants are at the top of
`engine.ts`.

### HUD

The HUD is a second three.js scene with its own camera and lights, drawn over
the game after a depth clear (`Engine.render()`). Everything in it is a
mesh: chrome-bezel gauges with sprung needles, a stopwatch with an LCD, a
terrain model with contour lines (a small shader), the turntable car (which
copies each real part's transform every frame, so loose parts hang and lost
ones vanish), and a book. It's laid out on the z = 0 plane in units of
1/10th of the screen height, so it scales with the window. Draw calls are
kept down: each seven-segment display is one instanced mesh with per-instance
colours, ticks are instanced, and each dial's numerals are one merged geometry.

### Gearbox

Six speeds, each with a redline road speed (`GEAR_TOP`) and a pull factor,
times a torque curve. Auto shifts up at 6,950 rpm and down at 3,300; each
shift cuts drive for 0.18 s. In manual, the limiter cuts drive at 7,600 rpm,
and being in too low a gear engine-brakes. Reverse engages by holding brake
at a standstill. Handling constants are at the top of `car.ts`.

### Damage model

Each detachable part has hit points by category (trim and lights are fragile,
wheels are tough). A hit damages parts near the contact point, weighted by
distance, scaled by impact speed (or, for knockable props, by how much they
slow the car). Damaged parts work loose on a hinge (the bonnet pops up, doors
swing, bumpers droop, mirrors fold) and wobble, then come off. Losing wheels
drops that corner, scrapes sparks, pulls the car sideways, and costs grip,
top speed and (front wheels, it's front-wheel drive) drive and steering.

## Performance notes

- No React renders during play: the game loop runs in one `useFrame`, and the
  HUD is updated through DOM refs at 15 Hz.
- ~350–450 draw calls and ~1.1M triangles per frame (both passes) in the
  busiest views. Simulation ≈ 0.05 ms per frame.
- Repeated props are `InstancedMesh`es chunked into 70 m cells, so the main
  and shadow passes can cull them. Knockable props are instanced too.
- Shadows come from one 2048² map that follows the car, snapped to texels.
- No textures except a small canvas texture for the asphalt. Materials are
  shared by name across the car and the props.
