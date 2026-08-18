#!/usr/bin/env python3
"""Export the pinned cs-net win-rate head without importing its Demo parser."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
from typing import Any

import torch


SOURCE_REVISION = "e15acc3fda3de21f25fe12a5ca31722381f40162"
CHECKPOINT_SHA256 = "23a8c07280542644d0609a4ab072c03f96001a95f50211d424248bfe4620c92d"
MODEL_SOURCE_SHA256 = "fb40c6be85e55fb9ac1fa46a8619d18ebe66382d3d51df8f5d9fdc44542e77d6"
CONFIG_SHA256 = "c4e745d44fd2f8787b9724f8d64e03266ec77f7ce1dc550b71c502bf3c1ba056"
TEMPERATURE = 1.0613423585891724
SPACE_SIZE = 31

INPUT_NAMES = (
    "mlp1_f",
    "mlp1_i",
    "mlp1_mask",
    "mlp2_f",
    "mlp2_mask",
    "mlp3_f",
    "mlp3_i",
    "mlp3_mask",
    "mlp4_f",
    "mlp4_mask",
    "mlp5_f",
    "mlp5_i",
    "mlp5_mask",
    "emb1_i",
    "emb1_mask",
    "emb2_i",
    "emb2_mask",
    "dead_mask",
    "pad_mask",
)

MODEL_CONFIG: dict[str, Any] = {
    "task": "winrate",
    "n_maps": 8,
    "n_weapons": 51,
    "n_projectiles": 2,
    "T_Size": 32,
    "Space_Size": SPACE_SIZE,
    "d": 256,
    "d_inventory_embedding": 64,
    "d_map_embedding": 32,
    "d_projectile_embedding": 32,
    "d_index_embedding": 32,
    "space_transformer": {
        "layers": 8,
        "d_model": 256,
        "n_heads": 8,
        "ffn_dim": 1536,
        "dropout": 0.1,
    },
    "MLP": {"layers": 3, "hidden_dim": 256},
    "Prediction_head": {"layers": 2, "hidden_dim": 256},
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_sha(path: Path, expected: str, label: str) -> None:
    actual = sha256(path)
    if actual != expected:
        raise RuntimeError(f"{label} SHA-256 mismatch: expected {expected}, received {actual}")


def load_model_class(model_source: Path):
    spec = importlib.util.spec_from_file_location("cs_net_model3_space_only", model_source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load model source: {model_source}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.CSModelV3


class WinRateHead(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(
        self,
        mlp1_f,
        mlp1_i,
        mlp1_mask,
        mlp2_f,
        mlp2_mask,
        mlp3_f,
        mlp3_i,
        mlp3_mask,
        mlp4_f,
        mlp4_mask,
        mlp5_f,
        mlp5_i,
        mlp5_mask,
        emb1_i,
        emb1_mask,
        emb2_i,
        emb2_mask,
        dead_mask,
        pad_mask,
    ):
        batch = {
            "mlp1_f": mlp1_f,
            "mlp1_i": mlp1_i,
            "mlp1_mask": mlp1_mask,
            "mlp2_f": mlp2_f,
            "mlp2_mask": mlp2_mask,
            "mlp3_f": mlp3_f,
            "mlp3_i": mlp3_i,
            "mlp3_mask": mlp3_mask,
            "mlp4_f": mlp4_f,
            "mlp4_mask": mlp4_mask,
            "mlp5_f": mlp5_f,
            "mlp5_i": mlp5_i,
            "mlp5_mask": mlp5_mask,
            "emb1_i": emb1_i,
            "emb1_mask": emb1_mask,
            "emb2_i": emb2_i,
            "emb2_mask": emb2_mask,
            "dead_mask": dead_mask,
            "pad_mask": pad_mask,
        }
        encoded = self.model.encode_tick(batch)
        contextualized = self.model.space_tf(encoded, pad_mask, dead_mask)
        return self.model.head(contextualized[:, 10, :]).squeeze(-1)


def dummy_inputs(batch_size: int = 2):
    torch.manual_seed(20260818)
    zeros_f = lambda *shape: torch.zeros((batch_size, *shape), dtype=torch.float32)
    zeros_i = lambda *shape: torch.zeros((batch_size, *shape), dtype=torch.int64)
    zeros_b = lambda *shape: torch.zeros((batch_size, *shape), dtype=torch.bool)
    mlp1_mask = zeros_b(SPACE_SIZE)
    mlp1_mask[:, :11] = True
    mlp2_mask = zeros_b(SPACE_SIZE)
    mlp2_mask[:, :10] = True
    mlp4_mask = zeros_b(SPACE_SIZE)
    mlp4_mask[:, 10] = True
    mlp5_mask = zeros_b(SPACE_SIZE, 9)
    mlp5_mask[:, :10, :9] = True
    emb1_mask = zeros_b(SPACE_SIZE, 9)
    emb1_mask[:, :10, :2] = True
    emb2_mask = zeros_b(SPACE_SIZE)
    emb2_mask[:, 10] = True
    pad_mask = zeros_b(SPACE_SIZE)
    pad_mask[:, 11:] = True
    return (
        zeros_f(SPACE_SIZE, 3),
        zeros_i(SPACE_SIZE),
        mlp1_mask,
        zeros_f(SPACE_SIZE, 14),
        mlp2_mask,
        zeros_f(SPACE_SIZE, 1),
        zeros_i(SPACE_SIZE),
        zeros_b(SPACE_SIZE),
        zeros_f(SPACE_SIZE, 4),
        mlp4_mask,
        zeros_f(SPACE_SIZE, 9, 13),
        zeros_i(SPACE_SIZE, 9),
        mlp5_mask,
        zeros_i(SPACE_SIZE, 9),
        emb1_mask,
        zeros_i(SPACE_SIZE),
        emb2_mask,
        zeros_b(SPACE_SIZE),
        pad_mask,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream-root", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--opset", type=int, default=18)
    args = parser.parse_args()

    upstream = args.upstream_root.resolve()
    checkpoint = (args.checkpoint or upstream / "cs-net-models/win_rate/latest_winrate.pt").resolve()
    model_source = upstream / "models/model3_space_only.py"
    config_source = upstream / "config/model3_win_space_only.yaml"
    assert_sha(checkpoint, CHECKPOINT_SHA256, "checkpoint")
    assert_sha(model_source, MODEL_SOURCE_SHA256, "model source")
    assert_sha(config_source, CONFIG_SHA256, "model config")

    model_class = load_model_class(model_source)
    model = model_class(MODEL_CONFIG)
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(state)
    wrapper = WinRateHead(model.eval()).eval()
    inputs = dummy_inputs()
    with torch.inference_mode():
        reference = wrapper(*inputs).detach().cpu().tolist()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    dynamic_axes = {name: {0: "batch"} for name in INPUT_NAMES}
    dynamic_axes["logit"] = {0: "batch"}
    torch.onnx.export(
        wrapper,
        inputs,
        args.output,
        export_params=True,
        opset_version=args.opset,
        do_constant_folding=True,
        input_names=list(INPUT_NAMES),
        output_names=["logit"],
        dynamic_axes=dynamic_axes,
        dynamo=False,
    )

    print(json.dumps({
        "schema_version": "cs-net-onnx-export/1.0.0",
        "source_revision": SOURCE_REVISION,
        "checkpoint_sha256": CHECKPOINT_SHA256,
        "temperature": TEMPERATURE,
        "opset": args.opset,
        "output": str(args.output),
        "output_sha256": sha256(args.output),
        "bytes": args.output.stat().st_size,
        "reference_logits": reference,
        "input_names": INPUT_NAMES,
    }, indent=2))


if __name__ == "__main__":
    main()
