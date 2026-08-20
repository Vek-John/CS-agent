#!/usr/bin/env python3
"""Sanity-check FP16 conversion against the original FP32 ONNX on a fixed fixture.

Browser acceptance compares FP16 WebGPU against FP32 WASM separately. This
script only catches conversion/runtime corruption before spending browser time.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


def load_export_module(path: Path):
    spec = importlib.util.spec_from_file_location("cs_net_export_fp16", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inputs(export_module, batch_size: int = 64):
    torch.manual_seed(20260818)
    values = []
    for index, value in enumerate(export_module.dummy_inputs()):
        value = value.repeat((batch_size, *([1] * (value.ndim - 1))))
        if value.is_floating_point():
            value = value + torch.randn_like(value) * 0.03
        elif value.dtype == torch.bool and index in {2, 4, 7, 9, 12, 14, 16, 17, 18}:
            value = value.clone()
            value[:, :10] = True
        values.append(value.numpy())
    return tuple(values)


def run(path: Path, values, names):
    model = onnx.load(str(path), load_external_data=True)
    onnx.checker.check_model(model)
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"],
                                   sess_options=ort.SessionOptions())
    return np.asarray(session.run(["logit"], dict(zip(names, values)))[0], dtype=np.float32)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fp32", type=Path, required=True)
    parser.add_argument("--fp16", type=Path, required=True)
    args = parser.parse_args()
    export = load_export_module(Path(__file__).with_name("export_winrate_onnx.py"))
    values = inputs(export)
    fp32 = run(args.fp32, values, export.INPUT_NAMES)
    fp16 = run(args.fp16, values, export.INPUT_NAMES)
    temperature = export.TEMPERATURE
    fp32_probability = 1 / (1 + np.exp(-fp32 / temperature))
    fp16_probability = 1 / (1 + np.exp(-fp16 / temperature))
    error = np.abs(fp32_probability - fp16_probability)
    result = {
        "fixture": {"batch": len(fp32), "temperature": temperature},
        "fp32_logits": {"min": float(fp32.min()), "max": float(fp32.max())},
        "fp16_cpu_vs_fp32": {
            "max_probability_abs_error": float(error.max()),
            "mean_probability_abs_error": float(error.mean()),
            "p95_probability_abs_error": float(np.percentile(error, 95)),
        },
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
