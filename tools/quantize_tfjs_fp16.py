"""Halve the download size of a TF.js model by storing float32 weights as float16.

TF.js dequantises the weights back to float32 when loading, so the model code is unchanged.
Used for models/coco-ssd-lite (COCO-SSD lite_mobilenet_v2, Apache-2.0, from
https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/).

Usage: python quantize_tfjs_fp16.py <input_dir> <output_dir>
Needs only numpy.
"""
import json
import pathlib
import sys

import numpy as np

SHARD_BYTES = 4 * 1024 * 1024
DTYPES = {"float32": np.float32, "int32": np.int32, "bool": np.bool_}


def main(src, dst):
    src, dst = pathlib.Path(src), pathlib.Path(dst)
    model = json.loads((src / "model.json").read_text())
    specs, out_specs, chunks = [], [], []
    for group in model["weightsManifest"]:
        data = b"".join((src / p).read_bytes() for p in group["paths"])
        offset = 0
        for spec in group["weights"]:
            if "quantization" in spec:
                raise SystemExit(f"{spec['name']} is already quantised")
            count = int(np.prod(spec["shape"])) if spec["shape"] else 1
            dtype = DTYPES[spec["dtype"]]
            size = count * np.dtype(dtype).itemsize
            values = np.frombuffer(data, dtype=dtype, count=count, offset=offset)
            offset += size
            spec = dict(spec)
            if spec["dtype"] == "float32":
                values = values.astype(np.float16)
                spec["quantization"] = {"dtype": "float16", "original_dtype": "float32"}
            chunks.append(values.tobytes())
            out_specs.append(spec)
        specs.extend(group["weights"])

    blob = b"".join(chunks)
    dst.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(0, len(blob), SHARD_BYTES):
        name = f"group1-shard{i // SHARD_BYTES + 1}of{(len(blob) + SHARD_BYTES - 1) // SHARD_BYTES}.bin"
        (dst / name).write_bytes(blob[i:i + SHARD_BYTES])
        paths.append(name)
    model["weightsManifest"] = [{"paths": paths, "weights": out_specs}]
    (dst / "model.json").write_text(json.dumps(model))
    print(f"{len(specs)} weights, {len(blob) / 1e6:.1f} MB in {len(paths)} shard(s) -> {dst}")


if __name__ == "__main__":
    main(*sys.argv[1:3])
