#!/usr/bin/env python3
"""Create a deterministic INT8 weight-only cs-net win-rate ONNX asset."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from onnxruntime.quantization import QuantType, quantize_dynamic


SAFE_ASSET_BYTES = 24 * 1024 * 1024


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    source = args.input.resolve()
    output = args.output.resolve()
    if not source.is_file():
        raise RuntimeError(f"Missing FP32 ONNX model: {source}")
    output.parent.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(source),
        model_output=str(output),
        per_channel=True,
        reduce_range=False,
        weight_type=QuantType.QInt8,
        extra_options={"EnableSubgraph": True},
    )
    size = output.stat().st_size
    if size >= SAFE_ASSET_BYTES:
        raise RuntimeError(
            f"INT8 model is {size} bytes; expected less than {SAFE_ASSET_BYTES} bytes"
        )
    print(json.dumps({
        "schema_version": "cs-net-onnx-quantization/1.0.0",
        "precision": "INT8_WEIGHT_ONLY",
        "input_sha256": sha256(source),
        "output_sha256": sha256(output),
        "bytes": size,
        "safe_asset_limit_bytes": SAFE_ASSET_BYTES,
        "output": str(output),
    }, indent=2))


if __name__ == "__main__":
    main()
