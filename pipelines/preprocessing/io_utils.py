"""Small atomic-write helpers for resumable preprocessing checkpoints."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from uuid import uuid4

import numpy as np
import pandas as pd


@contextmanager
def atomic_output_path(path: str | Path) -> Iterator[Path]:
    """Yield a sibling temporary path and atomically replace *path* on success."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(
        f".{target.stem}.{uuid4().hex}.tmp{target.suffix}"
    )
    try:
        yield temporary
        # Windows requires a writable descriptor for ``_commit``/``fsync``.
        with temporary.open("r+b") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()


def write_parquet_atomic(frame: pd.DataFrame, path: str | Path) -> Path:
    target = Path(path)
    with atomic_output_path(target) as temporary:
        frame.to_parquet(temporary, index=False)
    return target


def write_csv_atomic(frame: pd.DataFrame, path: str | Path) -> Path:
    target = Path(path)
    with atomic_output_path(target) as temporary:
        frame.to_csv(temporary, index=False)
    return target


def write_text_atomic(
    value: str,
    path: str | Path,
    *,
    encoding: str = "utf-8",
) -> Path:
    target = Path(path)
    with atomic_output_path(target) as temporary:
        temporary.write_text(value, encoding=encoding)
    return target


def write_numpy_atomic(array: np.ndarray, path: str | Path) -> Path:
    target = Path(path)
    if target.suffix.lower() != ".npy":
        raise ValueError("NumPy checkpoint path must end in .npy")
    with atomic_output_path(target) as temporary:
        np.save(temporary, array)
    return target


def write_json_atomic(
    value: Any,
    path: str | Path,
    *,
    indent: int = 2,
    ensure_ascii: bool = True,
) -> Path:
    target = Path(path)
    encoded = json.dumps(
        value,
        indent=indent,
        ensure_ascii=ensure_ascii,
        allow_nan=False,
    )
    with atomic_output_path(target) as temporary:
        temporary.write_text(encoded, encoding="utf-8")
    return target


__all__ = [
    "atomic_output_path",
    "write_csv_atomic",
    "write_json_atomic",
    "write_numpy_atomic",
    "write_parquet_atomic",
    "write_text_atomic",
]
