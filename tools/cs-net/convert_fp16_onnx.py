#!/usr/bin/env python3
"""Convert only the pinned FP32 cs-net asset to a reproducible FP16 PoC asset.

This script never reads the INT8 asset and refuses to overwrite any existing
output. The FP16 file is an experiment artifact, not a production asset.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import sys
from pathlib import Path

import onnx
import onnxruntime
from onnxruntime.transformers.float16 import DEFAULT_OP_BLOCK_LIST, convert_float_to_float16


CONVERTER = "onnxruntime.transformers.float16.convert_float_to_float16"
KEEP_IO_TYPES = True
FORCE_FP16_INITIALIZERS = False
DISABLE_SHAPE_INFER = False
MIN_POSITIVE_VALUE = 5.96e-8
MAX_FINITE_VALUE = 65504.0


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def topologically_sort_nodes(model: onnx.ModelProto) -> None:
    """Repair the ordering produced by ORT's keep_io_types converter.

    ORT 1.19 appends the input/output Cast nodes after the graph body. ONNX
    requires producer-before-consumer ordering, so perform a stable Kahn sort
    while retaining the converter's order whenever multiple nodes are ready.
    """
    graph = model.graph
    available = {item.name for item in graph.input}
    available.update(item.name for item in graph.initializer)
    remaining = list(graph.node)
    ordered = []
    while remaining:
        progressed = False
        next_remaining = []
        for node in remaining:
            inputs = {name for name in node.input if name}
            if inputs.issubset(available):
                ordered.append(node)
                available.update(name for name in node.output if name)
                progressed = True
            else:
                next_remaining.append(node)
        if not progressed:
            unresolved = sorted({name for node in next_remaining for name in node.input if name} - available)
            raise RuntimeError(f"Unable to topologically sort converted ONNX graph; unresolved inputs: {unresolved[:8]}")
        remaining = next_remaining
    del graph.node[:]
    graph.node.extend(ordered)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()

    source = args.input.resolve()
    output = args.output.resolve()
    manifest = args.manifest.resolve()
    if not source.is_file():
        raise RuntimeError(f"Missing source FP32 ONNX: {source}")
    if output == source:
        raise RuntimeError("FP16 output must be different from the source FP32 asset")
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite existing FP16 artifact: {output}")

    source_model = onnx.load(str(source), load_external_data=True)
    onnx.checker.check_model(source_model)
    converted = convert_float_to_float16(
        source_model,
        min_positive_val=MIN_POSITIVE_VALUE,
        max_finite_val=MAX_FINITE_VALUE,
        keep_io_types=KEEP_IO_TYPES,
        disable_shape_infer=DISABLE_SHAPE_INFER,
        op_block_list=list(DEFAULT_OP_BLOCK_LIST),
        node_block_list=[],
        force_fp16_initializers=FORCE_FP16_INITIALIZERS,
    )
    topologically_sort_nodes(converted)
    onnx.checker.check_model(converted)
    output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(converted, str(output), save_as_external_data=False)

    source_opsets = {str(item.domain): int(item.version) for item in source_model.opset_import}
    output_opsets = {str(item.domain): int(item.version) for item in converted.opset_import}
    result = {
        "schema_version": "cs-net-fp16-experiment/1.0.0",
        "status": "CONVERTED",
        "source": {
            "path": str(source),
            "precision": "FP32",
            "sha256": sha256(source),
            "bytes": source.stat().st_size,
        },
        "output": {
            "path": str(output),
            "precision": "FP16",
            "sha256": sha256(output),
            "bytes": output.stat().st_size,
        },
        "conversion": {
            "converter": CONVERTER,
            "onnxruntime_version": onnxruntime.__version__,
            "onnx_version": onnx.__version__,
            "python_version": platform.python_version(),
            "platform": platform.platform(),
            "opset_source": source_opsets,
            "opset_output": output_opsets,
            "keep_io_types": KEEP_IO_TYPES,
            "force_fp16_initializers": FORCE_FP16_INITIALIZERS,
            "disable_shape_infer": DISABLE_SHAPE_INFER,
            "min_positive_val": MIN_POSITIVE_VALUE,
            "max_finite_val": MAX_FINITE_VALUE,
            "op_block_list": sorted(DEFAULT_OP_BLOCK_LIST),
            "node_block_list": [],
            "external_data": False,
        },
        "limitations": [
            "Local PoC only; production default remains INT8 WASM auto 4 threads x batch 16.",
            "WebGPU provider purity and shader-f16 support are verified separately in the browser benchmark.",
        ],
    }
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
