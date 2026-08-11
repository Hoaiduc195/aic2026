"""Translate generated English captions into Vietnamese in local batches.

The translator keeps the English caption tree untouched and mirrors it into a
separate output directory.  Text is deduplicated before inference so repeated
captions across frames are translated only once.  The Hugging Face model is
loaded lazily, which keeps filesystem and unit-test helpers usable without the
optional ML dependencies installed.
"""

from __future__ import annotations

import argparse
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

MODEL_NAME = "Helsinki-NLP/opus-mt-en-vi"
# Pin the reviewed model revision so a future repository update cannot silently
# change the translation weights or tokenizer files.
MODEL_REVISION = "989c9fb"
DEFAULT_BATCH_SIZE = 64
DEFAULT_MAX_INPUT_TOKENS = 512
DEFAULT_MAX_NEW_TOKENS = 128
DEFAULT_NUM_BEAMS = 4


class BatchTranslator(Protocol):
    """Minimal interface required by the directory orchestration layer."""

    def translate(self, texts: Sequence[str]) -> Sequence[str]:
        """Translate a non-empty batch while preserving item order."""


@dataclass(frozen=True, slots=True)
class TranslationSummary:
    """Counts emitted by one deterministic translation partition."""

    discovered_files: int
    translated_files: int
    skipped_files: int
    empty_files: int
    unique_texts: int


def _natural_key(value: str | Path) -> tuple[tuple[int, int | str], ...]:
    """Sort numeric path components numerically instead of lexically."""

    pieces = re.split(r"(\d+)", str(value).replace("\\", "/"))
    return tuple(
        (0, int(piece)) if piece.isdigit() else (1, piece.casefold())
        for piece in pieces
        if piece
    )


def iter_caption_files(input_dir: Path) -> tuple[Path, ...]:
    """Return all UTF-8 caption candidates in stable natural-path order."""

    if not input_dir.is_dir():
        raise FileNotFoundError(f"Không tìm thấy input directory: {input_dir}")
    return tuple(
        sorted(
            (
                path
                for path in input_dir.rglob("*")
                if path.is_file() and path.suffix.casefold() == ".txt"
            ),
            key=lambda path: _natural_key(path.relative_to(input_dir)),
        )
    )


def validate_directory_layout(input_dir: Path, output_dir: Path) -> None:
    """Prevent output writes from recursively becoming new input files."""

    input_root = input_dir.resolve()
    output_root = output_dir.resolve()
    if output_root == input_root or input_root in output_root.parents:
        raise ValueError(
            "output_dir không được trùng hoặc nằm bên trong input_dir; "
            "hãy dùng một folder output riêng"
        )


def caption_path_for(input_dir: Path, output_dir: Path, caption_path: Path) -> Path:
    """Map one input caption to the equivalent path in the output tree."""

    try:
        relative_path = caption_path.resolve().relative_to(input_dir.resolve())
    except ValueError as error:
        raise ValueError("caption_path phải nằm bên trong input_dir") from error
    return output_dir / relative_path


def canonicalize_caption(text: str) -> str:
    """Collapse formatting whitespace used only for deduplication/inference."""

    return re.sub(r"\s+", " ", text).strip()


def partition_paths(
    paths: Sequence[Path], *, batch_index: int, num_batches: int
) -> tuple[Path, ...]:
    """Return one deterministic near-equal contiguous path partition."""

    if num_batches < 1:
        raise ValueError("num_batches phải lớn hơn 0")
    if batch_index < 0 or batch_index >= num_batches:
        raise ValueError("batch_index phải nằm trong khoảng 0..num_batches-1")

    values = tuple(paths)
    base_size, remainder = divmod(len(values), num_batches)
    start = batch_index * base_size + min(batch_index, remainder)
    size = base_size + (1 if batch_index < remainder else 0)
    return values[start : start + size]


def _chunked(items: Sequence[str], size: int) -> Iterator[tuple[str, ...]]:
    if size <= 0:
        raise ValueError("batch_size phải lớn hơn 0")
    for start in range(0, len(items), size):
        yield tuple(items[start : start + size])


def translate_in_batches(
    texts: Sequence[str], translator: BatchTranslator, *, batch_size: int
) -> tuple[str, ...]:
    """Translate texts in bounded batches and preserve the original order."""

    values = tuple(texts)
    translated: list[str] = []
    for batch in _chunked(values, batch_size):
        if not batch:
            continue
        result = tuple(translator.translate(batch))
        if len(result) != len(batch):
            raise ValueError(
                "translator phải trả về đúng một kết quả cho mỗi input caption"
            )
        if any(not isinstance(item, str) for item in result):
            raise TypeError("translator phải trả về các caption dạng chuỗi")
        translated.extend(result)
    return tuple(translated)


def _validate_translation_options(
    *,
    batch_size: int,
    max_input_tokens: int,
    max_new_tokens: int,
    num_beams: int,
) -> None:
    values = {
        "batch_size": batch_size,
        "max_input_tokens": max_input_tokens,
        "max_new_tokens": max_new_tokens,
        "num_beams": num_beams,
    }
    for name, value in values.items():
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{name} phải là số nguyên lớn hơn 0")


def _resolve_device(device: str, torch_module: Any) -> str:
    normalized = device.casefold().strip()
    if normalized == "auto":
        return "cuda" if torch_module.cuda.is_available() else "cpu"
    if normalized == "cpu":
        return "cpu"
    if normalized == "cuda" or normalized.startswith("cuda:"):
        if not torch_module.cuda.is_available():
            raise RuntimeError("CUDA được yêu cầu nhưng không khả dụng")
        return device
    raise ValueError("device phải là 'auto', 'cpu' hoặc 'cuda[:index]'")


class HuggingFaceTranslator:
    """Local batched translator backed by a MarianMT model."""

    def __init__(
        self,
        *,
        tokenizer: Any,
        model: Any,
        torch_module: Any,
        device: str,
        max_input_tokens: int,
        max_new_tokens: int,
        num_beams: int,
    ) -> None:
        self._tokenizer = tokenizer
        self._model = model
        self._torch = torch_module
        self._device = device
        self._max_input_tokens = max_input_tokens
        self._max_new_tokens = max_new_tokens
        self._num_beams = num_beams

    @classmethod
    def from_pretrained(
        cls,
        *,
        model_name: str = MODEL_NAME,
        revision: str = MODEL_REVISION,
        device: str = "auto",
        max_input_tokens: int = DEFAULT_MAX_INPUT_TOKENS,
        max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
        num_beams: int = DEFAULT_NUM_BEAMS,
    ) -> HuggingFaceTranslator:
        _validate_translation_options(
            batch_size=1,
            max_input_tokens=max_input_tokens,
            max_new_tokens=max_new_tokens,
            num_beams=num_beams,
        )
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        except ImportError as error:
            raise RuntimeError(
                "Cần cài requirements-translation.txt để chạy dịch local"
            ) from error

        resolved_device = _resolve_device(device, torch)
        tokenizer = AutoTokenizer.from_pretrained(
            model_name,
            revision=revision,
        )
        model = AutoModelForSeq2SeqLM.from_pretrained(
            model_name,
            revision=revision,
        )
        model = model.to(resolved_device)
        model.eval()
        return cls(
            tokenizer=tokenizer,
            model=model,
            torch_module=torch,
            device=resolved_device,
            max_input_tokens=max_input_tokens,
            max_new_tokens=max_new_tokens,
            num_beams=num_beams,
        )

    def translate(self, texts: Sequence[str]) -> tuple[str, ...]:
        values = tuple(texts)
        if not values:
            return ()
        encoded = self._tokenizer(
            list(values),
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=self._max_input_tokens,
        )
        encoded = {
            key: value.to(self._device) if hasattr(value, "to") else value
            for key, value in encoded.items()
        }
        with self._torch.inference_mode():
            generated_ids = self._model.generate(
                **encoded,
                max_new_tokens=self._max_new_tokens,
                num_beams=self._num_beams,
                early_stopping=self._num_beams > 1,
                do_sample=False,
            )
        decoded = self._tokenizer.batch_decode(
            generated_ids,
            skip_special_tokens=True,
        )
        return tuple(canonicalize_caption(text) for text in decoded)


def _write_text_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    temporary_path.write_text(text.rstrip() + "\n", encoding="utf-8")
    temporary_path.replace(path)


def translate_directory(
    input_dir: Path,
    output_dir: Path,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    batch_index: int = 0,
    num_batches: int = 1,
    overwrite: bool = False,
    device: str = "auto",
    model_name: str = MODEL_NAME,
    revision: str = MODEL_REVISION,
    max_input_tokens: int = DEFAULT_MAX_INPUT_TOKENS,
    max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
    num_beams: int = DEFAULT_NUM_BEAMS,
    translator: BatchTranslator | None = None,
) -> TranslationSummary:
    """Translate one deterministic partition of a caption directory."""

    _validate_translation_options(
        batch_size=batch_size,
        max_input_tokens=max_input_tokens,
        max_new_tokens=max_new_tokens,
        num_beams=num_beams,
    )
    validate_directory_layout(input_dir, output_dir)
    selected_paths = partition_paths(
        iter_caption_files(input_dir),
        batch_index=batch_index,
        num_batches=num_batches,
    )

    skipped_files = 0
    empty_files = 0
    grouped_paths: dict[str, list[Path]] = {}
    for source_path in selected_paths:
        output_path = caption_path_for(input_dir, output_dir, source_path)
        if output_path.is_file() and not overwrite:
            skipped_files += 1
            continue

        normalized_text = canonicalize_caption(
            source_path.read_text(encoding="utf-8")
        )
        if not normalized_text:
            _write_text_atomic(output_path, "")
            empty_files += 1
            continue
        grouped_paths.setdefault(normalized_text, []).append(source_path)

    if not grouped_paths:
        return TranslationSummary(
            discovered_files=len(selected_paths),
            translated_files=0,
            skipped_files=skipped_files,
            empty_files=empty_files,
            unique_texts=0,
        )

    active_translator = translator or HuggingFaceTranslator.from_pretrained(
        model_name=model_name,
        revision=revision,
        device=device,
        max_input_tokens=max_input_tokens,
        max_new_tokens=max_new_tokens,
        num_beams=num_beams,
    )
    unique_texts = tuple(grouped_paths)
    translated_texts = translate_in_batches(
        unique_texts,
        active_translator,
        batch_size=batch_size,
    )
    for source_text, translated_text in zip(unique_texts, translated_texts):
        if not translated_text.strip():
            raise ValueError(f"translator trả về caption rỗng cho: {source_text}")
        for source_path in grouped_paths[source_text]:
            _write_text_atomic(
                caption_path_for(input_dir, output_dir, source_path),
                translated_text,
            )

    return TranslationSummary(
        discovered_files=len(selected_paths),
        translated_files=sum(len(paths) for paths in grouped_paths.values()),
        skipped_files=skipped_files,
        empty_files=empty_files,
        unique_texts=len(unique_texts),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Translate English captions to Vietnamese in batches."
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        required=True,
        help="Folder containing English caption files (.txt).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Output folder for Vietnamese captions; input layout is preserved.",
    )
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--batch-index", type=int, default=0)
    parser.add_argument("--num-batches", type=int, default=1)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    parser.add_argument("--model-name", default=MODEL_NAME)
    parser.add_argument("--revision", default=MODEL_REVISION)
    parser.add_argument("--max-input-tokens", type=int, default=DEFAULT_MAX_INPUT_TOKENS)
    parser.add_argument("--max-new-tokens", type=int, default=DEFAULT_MAX_NEW_TOKENS)
    parser.add_argument("--num-beams", type=int, default=DEFAULT_NUM_BEAMS)
    parser.add_argument("--overwrite", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = translate_directory(
        args.input_dir,
        args.output_dir,
        batch_size=args.batch_size,
        batch_index=args.batch_index,
        num_batches=args.num_batches,
        overwrite=args.overwrite,
        device=args.device,
        model_name=args.model_name,
        revision=args.revision,
        max_input_tokens=args.max_input_tokens,
        max_new_tokens=args.max_new_tokens,
        num_beams=args.num_beams,
    )
    print(
        f"[done] discovered={summary.discovered_files} "
        f"translated={summary.translated_files} skipped={summary.skipped_files} "
        f"empty={summary.empty_files} unique_texts={summary.unique_texts}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
