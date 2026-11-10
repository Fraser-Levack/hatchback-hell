"""Weld an IronSmith .glb in place: share vertices and add an index buffer.

IronSmith writes triangle soup (3 unique vertices per triangle). Marching
tetrahedra puts each surface vertex in ~6 triangles, so welding is a
lossless ~3x size cut. Positions are matched to 1e-4 units; vertices that
merge keep the average of their normals.

    python glb_weld.py file.glb [more.glb ...] [--name NODE_NAME]
"""

import json
import struct
import sys

import numpy as np

GLB_MAGIC, JSON_CHUNK, BIN_CHUNK = 0x46546C67, 0x4E4F534A, 0x004E4942


def read_glb(path):
    data = open(path, "rb").read()
    magic, _, _ = struct.unpack_from("<III", data, 0)
    assert magic == GLB_MAGIC, f"{path}: not a GLB"
    off, doc, binary = 12, None, b""
    while off < len(data):
        length, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + length]
        if kind == JSON_CHUNK:
            doc = json.loads(chunk)
        elif kind == BIN_CHUNK:
            binary = chunk
        off += 8 + length
    return doc, binary


def accessor_array(doc, binary, idx):
    acc = doc["accessors"][idx]
    view = doc["bufferViews"][acc["bufferView"]]
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    assert acc["componentType"] == 5126 and acc["type"] == "VEC3"
    return np.frombuffer(binary, dtype="<f4", count=acc["count"] * 3, offset=start).reshape(-1, 3)


def weld(pos, nrm):
    keys = np.round(pos * 1e4).astype(np.int64)
    uniq, inverse = np.unique(keys, axis=0, return_inverse=True)
    inverse = inverse.reshape(-1)
    n = len(uniq)
    out_pos = np.zeros((n, 3), np.float64)
    out_nrm = np.zeros((n, 3), np.float64)
    counts = np.bincount(inverse, minlength=n)[:, None]
    np.add.at(out_pos, inverse, pos)
    np.add.at(out_nrm, inverse, nrm)
    out_pos /= counts
    lens = np.linalg.norm(out_nrm, axis=1, keepdims=True)
    out_nrm = np.where(lens > 1e-8, out_nrm / np.maximum(lens, 1e-8), [0, 1, 0])
    tris = inverse.reshape(-1, 3)
    # Drop triangles that collapsed onto a shared vertex.
    ok = (tris[:, 0] != tris[:, 1]) & (tris[:, 1] != tris[:, 2]) & (tris[:, 0] != tris[:, 2])
    return out_pos.astype("<f4"), out_nrm.astype("<f4"), tris[ok].reshape(-1)


def write_glb(path, doc, binary):
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + 8 + len(binary)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", GLB_MAGIC, 2, total))
        fh.write(struct.pack("<II", len(js), JSON_CHUNK) + js)
        fh.write(struct.pack("<II", len(binary), BIN_CHUNK) + binary)


def process(path, name=None):
    doc, binary = read_glb(path)
    if not doc.get("meshes"):
        return
    accessors, views, blob = [], [], bytearray()

    def add(arr, target, extra):
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": arr.nbytes, "target": target})
        blob.extend(arr.tobytes())
        accessors.append({"bufferView": len(views) - 1, **extra})
        return len(accessors) - 1

    before = after = 0
    for prim in doc["meshes"][0]["primitives"]:
        if "indices" in prim:
            raise SystemExit(f"{path}: already indexed")
        pos = accessor_array(doc, binary, prim["attributes"]["POSITION"])
        nrm = accessor_array(doc, binary, prim["attributes"]["NORMAL"])
        p, n, idx = weld(pos, nrm)
        before += len(pos)
        after += len(p)
        itype, comp = ("<u2", 5123) if len(p) < 65536 else ("<u4", 5125)
        prim["attributes"] = {
            "POSITION": add(p, 34962, {"componentType": 5126, "count": len(p), "type": "VEC3",
                                       "min": p.min(0).tolist(), "max": p.max(0).tolist()}),
            "NORMAL": add(n, 34962, {"componentType": 5126, "count": len(n), "type": "VEC3"}),
        }
        prim["indices"] = add(idx.astype(itype), 34963,
                              {"componentType": comp, "count": len(idx), "type": "SCALAR"})
    doc["accessors"], doc["bufferViews"] = accessors, views
    doc["buffers"] = [{"byteLength": len(blob)}]
    if name:
        doc["nodes"][0]["name"] = doc["meshes"][0]["name"] = name
    write_glb(path, doc, bytes(blob))
    print(f"welded {path}: {before} -> {after} vertices")


if __name__ == "__main__":
    args = sys.argv[1:]
    name = None
    if "--name" in args:
        i = args.index("--name")
        name = args[i + 1]
        del args[i:i + 2]
    for p in args:
        process(p, name)
