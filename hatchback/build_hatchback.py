"""Generate the breakable hatchback: one assembled scene plus one .irsm per part.

    python build_hatchback.py           # write the .irsm files + manifest.json
    python build_hatchback.py --export  # ...and export every part (and the whole car) to .glb
                                        # (--res N for part detail, default 96; needs numpy)

Units: 1 unit = 10 cm (the car is 40 units = 4 m long). Scale the car's root
by 0.1 in three.js for metres. The exporter sizes its sampling grid from a
coarse scan with ~1.5-unit cells, so modelling in decimetres keeps small parts
(mirrors, plates) sharp.

Layout: front faces +X, Y is up, ground at y = 0, the car is centred on x/z.

How the parts fit: the body is two shapes, `lower` (the tub up to the
waistline) and `cabin` (the glasshouse). Each detachable panel is the body
shape intersected with a region, and the core body is the body minus all of
those regions, so panels fit the hole they leave exactly. Panels that should
stand slightly proud (lights, glass, bumpers) use a grown copy of the body
(`lower(g)` / `cabin(g)` offsets every face outwards by g). Holes left in the
core are painted a dark interior colour.

Each part file draws the part around its own pivot (local origin); the pivot
in car space is in manifest.json, so in the game `mesh.position = pivot`
reassembles the car, and a detached part spins about its own centre (wheels
about their axle).
"""

import json
import math
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import glb_weld

HERE = Path(__file__).resolve().parent
S = 60.0  # size of the cubes used as half-space cutters

# ── Colours ──────────────────────────────────────────────────────────
BODY = "#C8161D"      # hot-hatch red
GLASS = "#121A22"
TRIM = "#141414"
INTERIOR = "#0B0B0C"
TYRE = "#1A1A1A"
RIM = "#C9CED4"
HEADLIGHT = "#E8E2C4"
TAILLIGHT = "#8A0A0A"
INDICATOR = "#9A4A06"
PLATE_F = "#E9E9E9"
PLATE_R = "#E8C21A"
CHROME = "#B8BCC2"


def f(v):
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def move(x, y, z, shape):
    return f"move({f(x)}, {f(y)}, {f(z)}, {shape})"


def cube(x, y, z):
    return f"cube({f(x)}, {f(y)}, {f(z)})"


def box(x0, x1, y0, y1, z0, z1):
    """Axis-aligned box from min/max corners."""
    return move((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, cube(x1 - x0, y1 - y0, z1 - z0))


def group(*shapes):
    shapes = [s for s in shapes if s]
    return shapes[0] if len(shapes) == 1 else "group(" + ", ".join(shapes) + ")"


def inter(*shapes):
    out = shapes[0]
    for s in shapes[1:]:
        out = f"intersection({out}, {s})"
    return out


def diff(a, b):
    return f"difference({a}, {b})"


def paint(c, *shapes, mat="plastic"):
    p = f"paint({c}, {', '.join(shapes)})"
    return f"material({mat}, {p})" if mat else p


# ── Half-spaces ──────────────────────────────────────────────────────
# halfZ: the region n.(p - p0) > g, with n = (nx, ny, 0) (a plane that
# contains the Z axis direction). halfX: same with n = (0, ny, nz).
# Used as a cutter it removes everything beyond the plane; used in an
# intersection it keeps it.

def halfZ(px, py, nx, ny, g=0.0):
    l = math.hypot(nx, ny)
    nx, ny = nx / l, ny / l
    theta = math.degrees(math.atan2(nx, ny))  # rotateZ(t) turns +Y towards +X
    d = g + S / 2
    return move(px + nx * d, py + ny * d, 0, f"rotateZ({f(theta)}, {cube(S, S, S)})")


def halfX(py, pz, ny, nz, g=0.0, px=0.0):
    l = math.hypot(ny, nz)
    ny, nz = ny / l, nz / l
    phi = math.degrees(math.atan2(nz, ny))  # rotateX(-p) turns +Y towards +Z
    d = g + S / 2
    return move(px, py + ny * d, pz + nz * d, f"rotateX({f(-phi)}, {cube(S, S, S)})")


def slabZ(px, py, nx, ny, lo, hi):
    """lo < n.(p - p0) < hi for n in the XY plane."""
    return inter(halfZ(px, py, nx, ny, lo), diff(cube(S, S, S), halfZ(px, py, nx, ny, hi)))


def slabX(py, pz, ny, nz, lo, hi):
    return inter(halfX(py, pz, ny, nz, lo), diff(cube(S, S, S), halfX(py, pz, ny, nz, hi)))


# ── Dimensions ───────────────────────────────────────────────────────
HL, HW = 19.5, 8.75          # lower body half length / half width
CORNER = 3.0                 # plan-view corner radius
FLOOR, BELT = 1.6, 8.2       # underside and waistline heights
ROOF = 14.2
WR, WW = 3.1, 2.0            # wheel radius / width
AXLE_F, AXLE_R = 12.0, -13.0
TRACK = 7.6                  # wheel centre |z|
ARCH = 3.75

# Glasshouse planes (side view lines, given as a point + outward normal)
WS = (7.2, BELT, 0.574, 0.819)       # windscreen, raked 35 degrees
REAR = (-19.2, BELT, -6.0, 4.2)      # hatch glass
SIDE_Z, SIDE_LEAN = 7.6, 14.0        # side glass base |z| and tumblehome
BONNET = (7.2, BELT, 1.2, 12.5)      # bonnet slopes 8.2 -> ~7.0 at the nose


def side_n(sign):
    a = math.radians(SIDE_LEAN)
    return math.sin(a), sign * math.cos(a)


def rounded_rect(hx, hz, r, y0, y1):
    h = y1 - y0
    yc = (y0 + y1) / 2
    corners = [move(sx * (hx - r), yc, sz * (hz - r), f"cylinder({f(r)}, {f(h)})")
               for sx in (1, -1) for sz in (1, -1)]
    return group(move(0, yc, 0, cube(2 * (hx - r), h, 2 * hz)),
                 move(0, yc, 0, cube(2 * hx, h, 2 * (hz - r))), *corners)


def lower(g=0.0):
    base = rounded_rect(HL + g, HW + g, CORNER + g, FLOOR - g, BELT + 0.4 + g)
    arch = f"rotateX(90, cylinder({f(ARCH - max(g, 0))}, 30))"
    cutters = group(
        halfZ(*BONNET, g),
        halfZ(HL, 6.3, 0.8, 0.6, g),            # nose top edge
        halfZ(HL, 2.6, 1, -1, g),               # front chin
        halfZ(-HL, 7.6, -1, 1, g),              # rear top edge
        halfZ(-HL, 2.4, -1, -1, g),             # rear underside
        halfX(7.6, HW, 1, 1, g),                # shoulder line, right
        halfX(7.6, -HW, 1, -1, g),              # shoulder line, left
        halfX(2.4, HW, -1, 1, g),               # sill tuck, right
        halfX(2.4, -HW, -1, -1, g),             # sill tuck, left
        move(AXLE_F, WR, 0, arch),
        move(AXLE_R, WR, 0, arch),
    )
    return diff(base, cutters)


def cabin(g=0.0):
    base = box(-21, 11, BELT - 0.3, ROOF + g, -SIDE_Z - 1 - g, SIDE_Z + 1 + g)
    ny, nzr = side_n(1)
    _, nzl = side_n(-1)
    roof_z = SIDE_Z - (ROOF - BELT) * math.tan(math.radians(SIDE_LEAN))
    cutters = group(
        halfZ(*WS, g),
        halfZ(*REAR, g),
        halfX(BELT, SIDE_Z, ny, nzr, g),
        halfX(BELT, -SIDE_Z, ny, nzl, g),
        halfX(ROOF, roof_z - 0.5, 1, 1, g),     # roof side edges
        halfX(ROOF, -(roof_z - 0.5), 1, -1, g),
        halfZ(-1.0, ROOF, 0.45, 1, g),          # soften roof front edge
    )
    return diff(base, cutters)


# Shape variables shared by every file (assignments draw nothing).
HEADER_VARS = {
    "lower0": lower(0),
    "lowerP": lower(0.07),   # bumpers / grille, slightly proud
    "lowerL": lower(0.12),   # lights
    "cabin0": cabin(0),
    "cabinG": cabin(0.12),   # glass
    "lowerIn": lower(-0.5),  # dark floor of the holes panels leave
    "cabinIn": cabin(-0.5),
}

# ── Regions (car space) ──────────────────────────────────────────────
# Glass panes
ws_slab = slabZ(*WS, -0.6, 1.0)
R_WINDSCREEN = inter(ws_slab, box(-5, 9, BELT + 0.5, ROOF - 0.55, -6.2, 6.2))

rear_slab = slabZ(*REAR, -0.7, 1.0)
R_HATCH_TOP = inter(rear_slab, box(-21, -13, BELT - 0.1, ROOF + 0.3, -5.9, 5.9))
R_HATCH_GLASS = inter(rear_slab, box(-21, -13, BELT + 0.8, ROOF - 0.7, -5.0, 5.0))


def side_slab(sign):
    ny, nz = side_n(sign)
    return slabX(BELT, sign * SIDE_Z, ny, nz, -0.6, 1.0)


def door_glass_region(sign):
    return diff(inter(side_slab(sign), box(-3.2, 9, BELT + 0.5, ROOF - 0.75, -12, 12)),
                halfZ(*WS, -1.0))  # leaves the A-pillar


def quarter_glass_region(sign):
    return diff(inter(side_slab(sign), box(-13.6, -4.6, BELT + 0.5, ROOF - 0.75, -12, 12)),
                halfZ(*REAR, -1.3))


def door_panel_region(sign):
    z0, z1 = (8.0, 11) if sign > 0 else (-11, -8.0)
    return box(-3.4, 6.9, 2.3, BELT + 0.45, z0, z1)


R_BONNET = inter(halfZ(*BONNET, -0.8), box(7.4, 22, 6.25, 12, -7.3, 7.3))
R_GRILLE = box(18.6, 22, 5.15, 6.25, -4.3, 4.3)


def headlight_region(sign):
    z0, z1 = (4.3, 11) if sign > 0 else (-11, -4.3)
    return box(17.2, 22, 5.15, 6.25, z0, z1)


def taillight_region(sign):
    z0, z1 = (5.9, 11) if sign > 0 else (-11, -5.9)
    return box(-22, -17.3, 5.4, 7.9, z0, z1)


R_HATCH_LOW = box(-22, -18.6, 5.0, BELT + 0.45, -5.85, 5.85)
R_BUMPER_F = box(16.2, 22, 0, 5.15, -11, 11)
R_BUMPER_R = box(-22, -16.8, 0, 5.0, -11, 11)

# ── Parts ────────────────────────────────────────────────────────────
parts = []


def part(name, pivot, shape, category, mass):
    parts.append({"name": name, "pivot": pivot, "shape": shape,
                  "category": category, "mass": mass})


# Core body: everything that never falls off. Holes left by panels are dark.
detach_regions = group(
    R_WINDSCREEN, R_HATCH_TOP, R_HATCH_LOW, R_BONNET, R_GRILLE,
    R_BUMPER_F, R_BUMPER_R,
    *[r(s) for s in (1, -1) for r in (door_glass_region, door_panel_region,
                                       headlight_region, taillight_region)],
)
# A difference's cut faces keep the colour of the shape being cut, so the
# dark floor of each hole is a copy of the body shrunk by 0.5, kept inside
# the regions. Every region is deeper than 0.5, so the floor shows.
body = group(paint(BODY, diff(group("lower0", "cabin0"), detach_regions)),
             paint(INTERIOR, inter(group("lowerIn", "cabinIn"), detach_regions), mat="matte"))
quarter = paint(GLASS, *[inter("cabinG", quarter_glass_region(s)) for s in (1, -1)])
underside = paint(TRIM, box(-16, 15.5, FLOOR - 0.15, FLOOR + 0.4, -7.2, 7.2), mat="matte")
part("body", [0, 7.5, 0], group(body, quarter, underside), "core", 650)

part("bonnet", [13.5, 7.6, 0], paint(BODY, inter("lower0", R_BONNET)), "panel", 15)

for s, side in ((1, "right"), (-1, "left")):
    panel = paint(BODY, inter("lower0", door_panel_region(s)))
    glass = paint(GLASS, inter("cabinG", door_glass_region(s)))
    handle = paint(TRIM, box(-2.6, -0.8, 6.85, 7.25, s * 8.55, s * 9.05) if s > 0
                   else box(-2.6, -0.8, 6.85, 7.25, -9.05, -8.55))
    part(f"door_{side}", [1.75, 7.5, s * 8.4], group(panel, glass, handle), "panel", 25)

part("windscreen", [3.3, 11.2, 0], paint(GLASS, inter("cabinG", R_WINDSCREEN)), "glass", 12)

hatch = group(paint(BODY, inter("cabin0", R_HATCH_TOP), inter("lower0", R_HATCH_LOW)),
              paint(GLASS, inter("cabinG", R_HATCH_GLASS)),
              paint(TRIM, box(-20.1, -19.2, 7.55, 7.85, -1.4, 1.4)))  # handle strip
part("tailgate", [-18.6, 9.5, 0], hatch, "panel", 20)

part("bumper_front", [18.2, 3.4, 0], group(
    paint(BODY, inter("lowerP", R_BUMPER_F)),
    paint(TRIM, inter("lowerL", box(17.5, 22, 1.9, 2.95, -6.6, 6.6)), mat="matte"),
    paint(TRIM, inter("lowerL", box(17.5, 22, 4.45, 4.8, -8, 8)), mat="matte"),  # lip under the lights
), "bumper", 8)

part("bumper_rear", [-18.6, 3.3, 0], group(
    paint(BODY, inter("lowerP", R_BUMPER_R)),
    paint(TRIM, inter("lowerL", box(-22, -17, 1.4, 2.5, -7.5, 7.5)), mat="matte"),  # diffuser
), "bumper", 8)

part("grille", [19.6, 5.7, 0], group(
    paint(TRIM, inter("lowerP", R_GRILLE)),
    paint(CHROME, inter("lowerL", box(18.6, 22, 5.62, 5.78, -4.2, 4.2)), mat="metal"),
), "trim", 2)

for s, side in ((1, "right"), (-1, "left")):
    hl = paint(HEADLIGHT, inter("lowerL", headlight_region(s)), mat="neon")
    ind = paint(INDICATOR, inter(f"lowerL", box(17.2, 22, 5.15, 5.45,
                                                *((7.2, 11) if s > 0 else (-11, -7.2)))), mat="neon")
    part(f"headlight_{side}", [19.0, 5.7, s * 6.8], group(hl, ind), "light", 1.5)
    tl = paint(TAILLIGHT, inter("lowerL", taillight_region(s)), mat="neon")
    part(f"taillight_{side}", [-19.2, 6.65, s * 7.7], tl, "light", 1)

# Wing mirrors, on the door just behind the A-pillar
for s, side in ((1, "right"), (-1, "left")):
    housing = move(5.5, 9.25, s * 9.6, inter(cube(1.6, 1.3, 2.4), "scale(1.05, 0.8, 1.5, sphere(1))"))
    arm = move(5.9, 8.75, s * 8.55, cube(0.8, 0.35, 1.5))
    glass = move(4.65, 9.25, s * 9.6, cube(0.12, 0.85, 1.75))
    part(f"mirror_{side}", [5.5, 9.1, s * 9.3],
         group(paint(BODY, housing), paint(TRIM, arm), paint(GLASS, glass, mat="metal")), "trim", 1.5)

spoiler = group(
    paint(TRIM, move(-15.4, 14.75, 0, f"rotateZ(-6, {cube(3.0, 0.32, 12.6)})")),
    paint(TRIM, move(-14.6, 14.35, 4.6, cube(1.4, 0.7, 0.35)), move(-14.6, 14.35, -4.6, cube(1.4, 0.7, 0.35))),
    paint(BODY, move(-15.7, 14.75, 6.4, cube(3.4, 0.8, 0.25)), move(-15.7, 14.75, -6.4, cube(3.4, 0.8, 0.25))),
)
part("spoiler", [-15.1, 14.6, 0], spoiler, "trim", 4)

part("exhaust", [-19.9, 2.1, -5.2], group(
    paint(CHROME, diff(move(-19.9, 2.1, -5.2, "rotateZ(90, cylinder(0.5, 2.6))"),
                       paint(TRIM, move(-21.2, 2.1, -5.2, "rotateZ(90, cylinder(0.33, 1.2))"))), mat="metal"),
), "trim", 3)

part("plate_front", [19.85, 3.75, 0], paint(PLATE_F, box(19.55, 20.15, 3.2, 4.3, -2.6, 2.6)), "trim", 0.5)
part("plate_rear", [-19.85, 6.4, 0], paint(PLATE_R, box(-20.15, -19.55, 5.85, 6.95, -2.6, 2.6)), "trim", 0.5)


# Wheels: built at the origin with the axle along Z and the face towards +Z.
def wheel_local():
    tyre = group(f"rotateX(90, cylinder({f(WR)}, {f(WW - 0.7)}))",
                 move(0, 0, WW / 2 - 0.36, "rotateX(90, torus(2.72, 0.38))"),
                 move(0, 0, -(WW / 2 - 0.36), "rotateX(90, torus(2.72, 0.38))"))
    tyre = diff(tyre, move(0, 0, 1.05, "rotateX(90, cylinder(2.15, 0.9))"))
    holes = group(*[move(1.25 * math.cos(math.radians(a)), 1.25 * math.sin(math.radians(a)), 0.95,
                         "rotateX(90, cylinder(0.5, 0.8))") for a in range(90, 450, 72)])
    rim = diff(move(0, 0, 0.2, "rotateX(90, cylinder(2.15, 1.4))"), paint(TRIM, holes, mat="matte"))
    hub = move(0, 0, 0.85, "rotateX(90, cylinder(0.6, 0.3))")
    return group(paint(TYRE, tyre, mat="matte"), paint(RIM, rim), paint(TRIM, hub))


WHEEL = wheel_local()
for x, end in ((AXLE_F, "front"), (AXLE_R, "rear")):
    for s, side in ((1, "right"), (-1, "left")):
        local = WHEEL if s > 0 else f"rotateY(180, {WHEEL})"
        part(f"wheel_{end}_{side}", [x, WR, s * TRACK], move(x, WR, s * TRACK, local), "wheel", 12)


# ── Output ───────────────────────────────────────────────────────────
HEAD = """// Generated by build_hatchback.py - edit that, not this file.
// Units: 1 = 10 cm. Front faces +X, Y up, ground at y = 0.
"""


def header(names):
    out = [HEAD]
    for k, v in HEADER_VARS.items():
        if any(k in n for n in names):
            out.append(f"{k} = {v}")
    return "\n".join(out) + "\n\n"


def write_all():
    parts_dir = HERE / "parts"
    parts_dir.mkdir(exist_ok=True)
    for p in parts:
        px, py, pz = p["pivot"]
        src = header([p["shape"]]) + f"// {p['name']}: pivot ({f(px)}, {f(py)}, {f(pz)}) in car space\n"
        src += move(-px, -py, -pz, p["shape"]) + "\n"
        (parts_dir / f"{p['name']}.irsm").write_text(src, encoding="utf-8")

    full = header([p["shape"] for p in parts]) + "light(0.6, 1.4, 0.9, 1.1)\n\n"
    for p in parts:
        full += f"// {p['name']}\n{p['shape']}\n\n"
    (HERE / "hatchback.irsm").write_text(full, encoding="utf-8")

    manifest = {
        "units": "1 unit = 10 cm (scale the car root by 0.1 for metres)",
        "forward": "+X", "up": "+Y",
        "assembled": "hatchback.glb",
        "parts": [{
            "name": p["name"], "file": f"glb/{p['name']}.glb", "pivot": p["pivot"],
            "category": p["category"], "detachable": p["category"] != "core",
            "mass_kg": p["mass"],
        } for p in parts],
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"wrote {len(parts)} parts")


def export_one(job):
    src, out, res, name = job
    r = subprocess.run(["ironsmith", "export", str(src), "-o", str(out), "--res", str(res)],
                       capture_output=True, text=True)
    if r.returncode:
        return f"FAILED {src.name}: {(r.stderr or r.stdout).strip()}"
    glb_weld.process(str(out), name)
    return f"{out.name}: {out.stat().st_size // 1024} KB"


def export_all(res):
    """Export each part (and the whole car) in parallel, then weld each GLB."""
    glb = HERE / "glb"
    glb.mkdir(exist_ok=True)
    jobs = [(HERE / "hatchback.irsm", HERE / "hatchback.glb", max(res, 128), "hatchback")]
    jobs += [(HERE / "parts" / f"{p['name']}.irsm", glb / f"{p['name']}.glb", res, p["name"]) for p in parts]
    with ThreadPoolExecutor(max(1, (os.cpu_count() or 2) // 2)) as pool:
        results = list(pool.map(export_one, jobs))
    print(chr(10).join(results))
    if any(r.startswith("FAILED") for r in results):
        sys.exit(1)


if __name__ == "__main__":
    write_all()
    if "--export" in sys.argv:
        export_all(int(sys.argv[sys.argv.index("--res") + 1]) if "--res" in sys.argv else 96)
