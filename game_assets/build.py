"""Export every model in irsm/ to glb/ (and optionally render previews/).

    python build.py              # export all
    python build.py cone ramp    # export models whose name contains "cone" or "ramp"
    python build.py --previews   # also render previews/<name>.png (opens the viewer)

Set IRONSMITH to the ironsmith binary to use (default: `ironsmith` on PATH).
The exporter must be the version with the model-fitted grid (Nov 2026+).
"""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXE = os.environ.get("IRONSMITH", "ironsmith")

# Sampling cells across each model's longest side. Bulky props need few
# (file size grows with the square of this); thin details need more.
RES = {
    "boulder": 48,
    "bush": 48,
    "rock_small": 48,
    "tyre_stack": 56,
    "wooden_crate": 56,
    "traffic_cone": 64,
    "oil_drum": 64,
    "pine_tree": 64,
    "oak_tree": 64,
    "hay_bale": 80,
    "jersey_barrier": 96,
    "jump_ramp": 96,
    "chevron_sign": 128,
    "fence": 128,
    "street_lamp": 192,
    "start_finish_gantry": 192,
}
DEFAULT_RES = 64


def export(src):
    out = HERE / "glb" / (src.stem + ".glb")
    res = RES.get(src.stem, DEFAULT_RES)
    r = subprocess.run([EXE, "export", str(src), "-o", str(out), "--res", str(res)],
                       capture_output=True, text=True)
    if r.returncode:
        return f"FAILED {src.name}: {(r.stderr or r.stdout).strip()}"
    return f"{src.stem:20} res {res:3}  {out.stat().st_size / 1e6:5.2f} MB"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sources = sorted((HERE / "irsm").glob("*.irsm"))
    if args:
        sources = [s for s in sources if any(a in s.stem for a in args)]
    (HERE / "glb").mkdir(exist_ok=True)
    with ThreadPoolExecutor(max(1, (os.cpu_count() or 2) // 2)) as pool:
        results = list(pool.map(export, sources))
    print("\n".join(results))
    if "--previews" in sys.argv:
        (HERE / "previews").mkdir(exist_ok=True)
        for s in sources:  # one viewer: render one at a time
            subprocess.run([EXE, "render", str(s), "-o", str(HERE / "previews" / (s.stem + ".png"))])
    if any(r.startswith("FAILED") for r in results):
        sys.exit(1)


if __name__ == "__main__":
    main()
