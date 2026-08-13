"""Optional Codex Terra narration for already-validated coaching cues.

The worker owns facts, ticks, references, confidence and playback semantics.
Terra receives only decision-side structured evidence and may return two text
fields per cue.  Any provider failure or contract violation leaves the
deterministic template untouched.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .models import ParseWarning
from .replay_models import ReplayReviewCue, ReplayReviewPlan


TERRA_PROVIDER = "CODEX_TERRA"
TEMPLATE_PROVIDER = "DETERMINISTIC_TEMPLATE"
TERRA_MODEL = "gpt-5.6-terra"
TERRA_PROMPT_VERSION = "terra-cue-narration/1.0.0"
TERRA_TIMEOUT_SECONDS = 45.0


class TerraAdapterError(RuntimeError):
    """Stable, non-sensitive failure code for the optional provider."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class TerraSettings:
    enabled: bool = False
    model: str = TERRA_MODEL
    timeout_seconds: float = TERRA_TIMEOUT_SECONDS
    codex_path: str = "codex"


class TerraRunner(Protocol):
    def run(
        self,
        payload: dict[str, object],
        expected_cue_ids: tuple[str, ...],
    ) -> dict[str, object]:
        """Return the strict JSON object emitted by the provider."""


def _truthy(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def _workspace_root() -> Path:
    # terra_adapter.py -> cs2_demo_parser -> src -> analysis -> workers -> repo
    return Path(__file__).resolve().parents[4]


def _local_flag(name: str) -> str | None:
    """Read only the requested non-secret feature flag, without logging it."""

    path = _workspace_root() / ".env.local"
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() == name:
                    return value.strip().strip("'\"")
    except OSError:
        return None
    return None


def terra_settings_from_environment() -> TerraSettings:
    enabled_value = os.environ.get("CS2_TERRA_ENABLED")
    if enabled_value is None:
        enabled_value = _local_flag("CS2_TERRA_ENABLED")
    model = os.environ.get("CS2_TERRA_MODEL", TERRA_MODEL).strip() or TERRA_MODEL
    timeout_raw = os.environ.get("CS2_TERRA_TIMEOUT_SECONDS", str(TERRA_TIMEOUT_SECONDS))
    try:
        timeout_seconds = max(1.0, min(180.0, float(timeout_raw)))
    except (TypeError, ValueError):
        timeout_seconds = TERRA_TIMEOUT_SECONDS
    return TerraSettings(
        enabled=_truthy(enabled_value),
        model=model,
        timeout_seconds=timeout_seconds,
        codex_path=os.environ.get("CODEX_BIN", "codex").strip() or "codex",
    )


def _decision_payload(plan: ReplayReviewPlan) -> dict[str, object]:
    """Build the only payload allowed to cross the model boundary."""

    cues: list[dict[str, object]] = []
    for cue in plan.cues:
        observable_ids = set(cue.observable_fact_refs)
        decision_facts = [
            fact.model_dump(mode="json")
            for fact in cue.facts
            if fact.id in observable_ids and fact.availability == "DECISION"
        ]
        cues.append(
            {
                "cue_id": cue.id,
                "cue_type": cue.cue_type,
                "decision_tick": cue.decision_tick,
                "facts": decision_facts,
                "inferences": [item.model_dump(mode="json") for item in cue.inferences],
                "advice": [item.model_dump(mode="json") for item in cue.advice],
                "limitations": list(cue.limitations),
            }
        )
    return {"cues": cues}


def _output_schema(expected_cue_ids: tuple[str, ...]) -> dict[str, object]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "minItems": len(expected_cue_ids),
                "maxItems": len(expected_cue_ids),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["cue_id", "title", "explanation"],
                    "properties": {
                        "cue_id": {"type": "string", "enum": list(expected_cue_ids)},
                        "title": {"type": "string", "minLength": 1, "maxLength": 120},
                        "explanation": {"type": "string", "minLength": 1, "maxLength": 1600},
                    },
                },
            }
        },
    }


def _prompt(payload: dict[str, object]) -> str:
    return (
        "你是 CS2 AI Demo Coach 的讲解措辞适配器。\n"
        "只根据下面提供的 decision-side 结构化事实生成自然语言讲解。\n"
        "不要补充敌方位置、身份、结果、语音、职业样本或任何未提供事实。\n"
        "不要改变 tick、segment、事实、引用、置信度或播放控制；只返回每个 cue 的 title 和 explanation。\n"
        "不要输出 Markdown、代码围栏或额外字段。严格返回 schema 要求的 JSON。\n\n"
        + json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )


class CodexTerraRunner:
    """One ephemeral, read-only, schema-constrained Codex invocation."""

    def __init__(self, *, model: str = TERRA_MODEL, timeout_seconds: float = TERRA_TIMEOUT_SECONDS, codex_path: str = "codex") -> None:
        self.model = model
        self.timeout_seconds = timeout_seconds
        self.codex_path = codex_path

    def run(
        self,
        payload: dict[str, object],
        expected_cue_ids: tuple[str, ...],
    ) -> dict[str, object]:
        executable = shutil.which(self.codex_path) or (
            self.codex_path if Path(self.codex_path).is_file() else None
        )
        if executable is None:
            raise TerraAdapterError("CODEX_CLI_MISSING")

        with tempfile.TemporaryDirectory(prefix="cs2-terra-") as temporary:
            temp_root = Path(temporary)
            schema_path = temp_root / "output-schema.json"
            output_path = temp_root / "last-message.json"
            schema_path.write_text(
                json.dumps(_output_schema(expected_cue_ids), ensure_ascii=False),
                encoding="utf-8",
            )
            command = [
                executable,
                "exec",
                "--ephemeral",
                "--ignore-user-config",
                "--ignore-rules",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--model",
                self.model,
                "--output-schema",
                str(schema_path),
                "--output-last-message",
                str(output_path),
                "-C",
                str(temp_root),
                "-",
            ]
            try:
                completed = subprocess.run(
                    command,
                    input=_prompt(payload),
                    text=True,
                    capture_output=True,
                    timeout=self.timeout_seconds,
                    check=False,
                )
            except subprocess.TimeoutExpired as exc:
                raise TerraAdapterError("CODEX_TERRA_TIMEOUT") from exc
            except OSError as exc:
                raise TerraAdapterError("CODEX_TERRA_EXEC_ERROR") from exc
            if completed.returncode != 0:
                raise TerraAdapterError("CODEX_TERRA_PROCESS_EXIT")
            try:
                raw = output_path.read_text(encoding="utf-8")
            except OSError as exc:
                raise TerraAdapterError("CODEX_TERRA_OUTPUT_MISSING") from exc
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise TerraAdapterError("CODEX_TERRA_INVALID_JSON") from exc
            if not isinstance(parsed, dict):
                raise TerraAdapterError("CODEX_TERRA_INVALID_SHAPE")
            return parsed


def _validate_result(
    raw: dict[str, object],
    expected_cue_ids: tuple[str, ...],
) -> dict[str, dict[str, str]]:
    if set(raw) != {"items"} or not isinstance(raw.get("items"), list):
        raise TerraAdapterError("CODEX_TERRA_SCHEMA_OR_ID_FAILURE")
    items = raw["items"]
    if len(items) != len(expected_cue_ids):
        raise TerraAdapterError("CODEX_TERRA_SCHEMA_OR_ID_FAILURE")
    expected = set(expected_cue_ids)
    result: dict[str, dict[str, str]] = {}
    for item in items:
        if not isinstance(item, dict) or set(item) != {"cue_id", "title", "explanation"}:
            raise TerraAdapterError("CODEX_TERRA_SCHEMA_OR_ID_FAILURE")
        cue_id = item.get("cue_id")
        title = item.get("title")
        explanation = item.get("explanation")
        if (
            not isinstance(cue_id, str)
            or cue_id not in expected
            or cue_id in result
            or not isinstance(title, str)
            or not title.strip()
            or len(title) > 120
            or not isinstance(explanation, str)
            or not explanation.strip()
            or len(explanation) > 1600
        ):
            raise TerraAdapterError("CODEX_TERRA_SCHEMA_OR_ID_FAILURE")
        result[cue_id] = {"title": title.strip(), "explanation": explanation.strip()}
    if set(result) != expected:
        raise TerraAdapterError("CODEX_TERRA_SCHEMA_OR_ID_FAILURE")
    return result


def _manifest_update(
    plan: ReplayReviewPlan,
    *,
    provider: str,
    model: str | None,
    status: str,
    limitation: str | None = None,
) -> ReplayReviewPlan:
    manifest = plan.generation_manifest
    limitations = list(manifest.limitations)
    if limitation and limitation not in limitations:
        limitations.append(limitation)
    return plan.model_copy(
        update={
            "generation_manifest": manifest.model_copy(
                update={
                    "provider": provider,
                    "model": model,
                    "prompt_version": TERRA_PROMPT_VERSION,
                    "status": status,
                    "limitations": limitations,
                }
            )
        }
    )


def apply_terra_narration(
    plan: ReplayReviewPlan,
    *,
    settings: TerraSettings,
    runner: TerraRunner | None = None,
    warnings: list[ParseWarning] | None = None,
) -> ReplayReviewPlan:
    """Enrich cue wording while retaining deterministic facts and controls."""

    if not settings.enabled:
        return _manifest_update(
            plan,
            provider=TEMPLATE_PROVIDER,
            model=None,
            status="DISABLED",
        )
    if not plan.cues:
        return _manifest_update(
            plan,
            provider=TERRA_PROVIDER,
            model=settings.model,
            status="SUCCEEDED",
            limitation="No cues required Terra narration for this plan.",
        )

    expected_ids = tuple(cue.id for cue in plan.cues)
    payload = _decision_payload(plan)
    provider = runner or CodexTerraRunner(
        model=settings.model,
        timeout_seconds=settings.timeout_seconds,
        codex_path=settings.codex_path,
    )
    started = time.perf_counter()
    try:
        raw = provider.run(payload, expected_ids)
        generated = _validate_result(raw, expected_ids)
    except TerraAdapterError as exc:
        if warnings is not None:
            warnings.append(
                ParseWarning(
                    code="TERRA_NARRATION_FALLBACK",
                    message="Codex Terra narration was unavailable or invalid; deterministic cue templates were retained.",
                    field="review_plan.generation_manifest",
                    details={"reason_code": exc.code},
                )
            )
        return _manifest_update(
            plan,
            provider=TERRA_PROVIDER,
            model=settings.model,
            status="FALLBACK",
            limitation=f"Terra narration fallback: {exc.code}; deterministic template retained.",
        )

    # Do not accept model-controlled IDs, refs, ticks, confidence or controls.
    enriched: list[ReplayReviewCue] = []
    for cue in plan.cues:
        text = generated[cue.id]["explanation"]
        inferences = list(cue.inferences)
        if inferences:
            inferences[0] = inferences[0].model_copy(update={"text": text})
        enriched.append(
            cue.model_copy(
                update={
                    "title": generated[cue.id]["title"],
                    "question": text,
                    "inferences": inferences,
                }
            )
        )
    _ = time.perf_counter() - started
    return _manifest_update(
        plan.model_copy(update={"cues": enriched}),
        provider=TERRA_PROVIDER,
        model=settings.model,
        status="SUCCEEDED",
        limitation="Terra supplies non-deterministic natural-language cue wording; facts, references, confidence and playback remain deterministic worker outputs.",
    )

