"""Semantic checks that cannot be expressed by JSON Schema alone.

JSON Schema validates field shape and types. These small, dependency-free
checks are intended to run immediately after schema validation at artifact and
response boundaries.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from numbers import Real


class ContractSemanticError(ValueError):
    """Raised when a contract is shaped correctly but semantically invalid."""


def _number(record: Mapping[str, object], name: str) -> Real:
    value = record.get(name)
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(value):
        raise ContractSemanticError(f"{name} must be a finite number")
    return value


def _integer(record: Mapping[str, object], name: str) -> int:
    value = record.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractSemanticError(f"{name} must be an integer")
    return value


def _validate_interval(record: Mapping[str, object], start_name: str, end_name: str) -> None:
    start = _number(record, start_name)
    end = _number(record, end_name)
    if start < 0 or end <= start:
        raise ContractSemanticError(f"{end_name} must be greater than {start_name}")


def _validate_event_window(record: Mapping[str, object]) -> None:
    _validate_interval(record, "start_ms", "end_ms")
    if "start_frame_id" in record and "end_frame_id" in record:
        start = _integer(record, "start_frame_id")
        end = _integer(record, "end_frame_id")
        if start < 0 or end <= start:
            raise ContractSemanticError("event window frame interval must be half-open and non-empty")


def _validate_trake_alignment(record: Mapping[str, object]) -> None:
    status = record.get("status")
    events = record.get("events", [])
    if not isinstance(events, Sequence) or isinstance(events, (str, bytes)):
        raise ContractSemanticError("TRAKE events must be an array")
    if status == "completed" and not events:
        raise ContractSemanticError("completed TRAKE alignment must contain events")
    if not events:
        return

    ordinals: list[int] = []
    frame_ids: list[int] = []
    for event in events:
        if not isinstance(event, Mapping):
            raise ContractSemanticError("TRAKE event must be an object")
        ordinals.append(_integer(event, "event_ordinal"))
        frame_ids.append(_integer(event, "original_frame_id"))

    if ordinals != list(range(1, len(ordinals) + 1)):
        raise ContractSemanticError("TRAKE event_ordinal values must be contiguous and ordered")
    if any(current <= previous for previous, current in zip(frame_ids, frame_ids[1:])):
        raise ContractSemanticError("TRAKE original_frame_id values must strictly increase")


def _validate_vqa(record: Mapping[str, object]) -> None:
    status = record.get("answer_status")
    if status not in {"answered", "needs_more_evidence", "abstained"}:
        raise ContractSemanticError("VQA answer_status is invalid")
    if status != "answered":
        return
    answer = record.get("answer")
    evidence_ids = record.get("evidence_ids")
    if not isinstance(answer, str) or not answer.strip():
        raise ContractSemanticError("answered VQA results require a non-empty answer")
    if not isinstance(evidence_ids, Sequence) or isinstance(evidence_ids, (str, bytes)) or not evidence_ids:
        raise ContractSemanticError("answered VQA results require evidence_ids")


def _validate_qualification_response(record: Mapping[str, object]) -> None:
    task = record.get("task")
    results = record.get("results", [])
    if not isinstance(results, Sequence) or isinstance(results, (str, bytes)):
        raise ContractSemanticError("qualification results must be an array")
    expected_type = {"textual_kis": "textual_kis", "vqa": "vqa", "trake": "trake"}.get(task)
    for result in results:
        if not isinstance(result, Mapping) or result.get("result_type") != expected_type:
            raise ContractSemanticError("qualification result type does not match task")
        if expected_type == "vqa":
            _validate_vqa(result)
        elif expected_type == "trake":
            _validate_trake_alignment({"status": "completed", "events": result.get("events", [])})


def validate_record_semantics(schema_name: str, record: Mapping[str, object]) -> None:
    """Validate cross-field invariants after JSON Schema validation."""

    if schema_name in {"event_window", "micro_event", "context_window"}:
        _validate_interval(record, "start_ms", "end_ms")
        if schema_name == "event_window":
            _validate_event_window(record)
    elif schema_name == "trake_alignment":
        _validate_trake_alignment(record)
    elif schema_name == "vqa_response":
        _validate_vqa(record)
    elif schema_name == "qualification_response":
        _validate_qualification_response(record)
