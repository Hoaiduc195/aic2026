from __future__ import annotations

import sys
import tempfile
import types
import unittest
from collections.abc import Sequence
from pathlib import Path
from unittest import mock

from pipelines.feature_extraction.captioning import translate_captions as translation


class _RecordingTranslator:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def translate(self, texts: Sequence[str]) -> tuple[str, ...]:
        batch = tuple(texts)
        self.calls.append(batch)
        return tuple(f"VI: {text}" for text in batch)


class TranslationPathTests(unittest.TestCase):
    def test_iter_caption_files_naturally_sorts_and_filters_txt_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            (root / "L21_V001").mkdir()
            (root / "L21_V001" / "010.txt").touch()
            (root / "L21_V001" / "002.txt").touch()
            (root / "L21_V001" / "001.jpg").touch()
            (root / "L21_V002").mkdir()
            (root / "L21_V002" / "001.TXT").touch()

            result = translation.iter_caption_files(root)

            self.assertEqual(
                tuple(path.relative_to(root).as_posix() for path in result),
                ("L21_V001/002.txt", "L21_V001/010.txt", "L21_V002/001.TXT"),
            )

    def test_partition_paths_balances_remainder_without_overlap(self) -> None:
        paths = tuple(Path(f"{index}.txt") for index in range(5))

        partitions = tuple(
            translation.partition_paths(paths, batch_index=index, num_batches=3)
            for index in range(3)
        )

        self.assertEqual(tuple(len(partition) for partition in partitions), (2, 2, 1))
        self.assertEqual(
            set().union(*map(set, partitions)),
            set(paths),
        )
        self.assertEqual(sum(len(set(partition)) for partition in partitions), len(paths))

    def test_partition_paths_rejects_invalid_batch_options(self) -> None:
        with self.assertRaises(ValueError):
            translation.partition_paths((Path("a.txt"),), batch_index=0, num_batches=0)
        with self.assertRaises(ValueError):
            translation.partition_paths((Path("a.txt"),), batch_index=1, num_batches=1)

    def test_output_directory_cannot_be_inside_input_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            input_dir = Path(temporary_directory) / "captioning"
            input_dir.mkdir()

            with self.assertRaises(ValueError):
                translation.validate_directory_layout(
                    input_dir,
                    input_dir / "captioning_vi",
                )


class TranslationBatchTests(unittest.TestCase):
    def test_translate_directory_deduplicates_and_preserves_parallel_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_dir = root / "captioning"
            output_dir = root / "captioning_vi"
            (input_dir / "L21_V001").mkdir(parents=True)
            (input_dir / "L21_V002").mkdir(parents=True)
            (input_dir / "L21_V001" / "001.txt").write_text(
                "A person walks.", encoding="utf-8"
            )
            (input_dir / "L21_V001" / "002.txt").write_text(
                "  A person   walks.\n", encoding="utf-8"
            )
            (input_dir / "L21_V002" / "001.txt").write_text(
                "A car waits.", encoding="utf-8"
            )
            translator = _RecordingTranslator()

            summary = translation.translate_directory(
                input_dir,
                output_dir,
                batch_size=1,
                translator=translator,
            )

            self.assertEqual(summary.discovered_files, 3)
            self.assertEqual(summary.translated_files, 3)
            self.assertEqual(summary.unique_texts, 2)
            self.assertEqual(summary.skipped_files, 0)
            self.assertEqual(
                translator.calls,
                [("A person walks.",), ("A car waits.",)],
            )
            self.assertEqual(
                (output_dir / "L21_V001" / "001.txt").read_text(encoding="utf-8"),
                "VI: A person walks.\n",
            )
            self.assertEqual(
                (output_dir / "L21_V001" / "002.txt").read_text(encoding="utf-8"),
                "VI: A person walks.\n",
            )
            self.assertEqual(
                (output_dir / "L21_V002" / "001.txt").read_text(encoding="utf-8"),
                "VI: A car waits.\n",
            )
            self.assertEqual(
                (input_dir / "L21_V001" / "002.txt").read_text(encoding="utf-8"),
                "  A person   walks.\n",
            )

    def test_translate_directory_resumes_existing_and_writes_empty_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            input_dir = root / "captioning"
            output_dir = root / "captioning_vi"
            input_dir.mkdir()
            (input_dir / "empty.txt").write_text("\n", encoding="utf-8")
            (input_dir / "pending.txt").write_text("A bird flies.", encoding="utf-8")
            (input_dir / "done.txt").write_text("A car waits.", encoding="utf-8")
            (output_dir / "done.txt").parent.mkdir(parents=True)
            (output_dir / "done.txt").write_text("Đã có sẵn.\n", encoding="utf-8")
            translator = _RecordingTranslator()

            summary = translation.translate_directory(
                input_dir,
                output_dir,
                translator=translator,
            )

            self.assertEqual(summary.discovered_files, 3)
            self.assertEqual(summary.skipped_files, 1)
            self.assertEqual(summary.empty_files, 1)
            self.assertEqual(summary.translated_files, 1)
            self.assertEqual(summary.unique_texts, 1)
            self.assertEqual(translator.calls, [("A bird flies.",)])
            self.assertEqual(
                (output_dir / "empty.txt").read_text(encoding="utf-8"),
                "\n",
            )
            self.assertEqual(
                (output_dir / "done.txt").read_text(encoding="utf-8"),
                "Đã có sẵn.\n",
            )

    def test_translate_in_batches_rejects_wrong_result_count(self) -> None:
        class BadTranslator:
            def translate(self, texts: Sequence[str]) -> tuple[str, ...]:
                del texts
                return ("only one result",)

        with self.assertRaises(ValueError):
            translation.translate_in_batches(
                ("first", "second"),
                BadTranslator(),
                batch_size=2,
            )

    def test_translate_in_batches_rejects_invalid_batch_size(self) -> None:
        with self.assertRaises(ValueError):
            translation.translate_in_batches(
                ("caption",),
                _RecordingTranslator(),
                batch_size=0,
            )


class HuggingFaceTranslatorTests(unittest.TestCase):
    def test_from_pretrained_uses_revision_and_batches_without_real_dependencies(self) -> None:
        tokenizer_load_calls: list[tuple[str, str]] = []
        model_load_calls: list[tuple[str, str]] = []

        class FakeTensor:
            def __init__(self) -> None:
                self.device: str | None = None

            def to(self, device: str) -> FakeTensor:
                self.device = device
                return self

        class FakeInferenceMode:
            def __enter__(self) -> None:
                return None

            def __exit__(self, *_args: object) -> None:
                return None

        class FakeTorch(types.ModuleType):
            class cuda:
                @staticmethod
                def is_available() -> bool:
                    return False

            @staticmethod
            def inference_mode() -> FakeInferenceMode:
                return FakeInferenceMode()

        class FakeTokenizer:
            @classmethod
            def from_pretrained(cls, model_name: str, revision: str) -> FakeTokenizer:
                tokenizer_load_calls.append((model_name, revision))
                return cls()

            def __call__(self, texts: list[str], **_kwargs: object) -> dict[str, FakeTensor]:
                self.input_ids = FakeTensor()
                self.attention_mask = FakeTensor()
                self.texts = tuple(texts)
                return {
                    "input_ids": self.input_ids,
                    "attention_mask": self.attention_mask,
                }

            def batch_decode(
                self, _generated_ids: object, *, skip_special_tokens: bool
            ) -> tuple[str, ...]:
                self.skip_special_tokens = skip_special_tokens
                return ("Xin chào",)

        class FakeModel:
            @classmethod
            def from_pretrained(cls, model_name: str, revision: str) -> FakeModel:
                model_load_calls.append((model_name, revision))
                return cls()

            def to(self, device: str) -> FakeModel:
                self.device = device
                return self

            def eval(self) -> None:
                self.evaluated = True

            def generate(self, **kwargs: object) -> object:
                self.generate_kwargs = kwargs
                return object()

        fake_torch = FakeTorch("torch")
        fake_transformers = types.ModuleType("transformers")
        fake_transformers.AutoTokenizer = FakeTokenizer
        fake_transformers.AutoModelForSeq2SeqLM = FakeModel

        with mock.patch.dict(
            sys.modules,
            {"torch": fake_torch, "transformers": fake_transformers},
        ):
            translator = translation.HuggingFaceTranslator.from_pretrained(
                device="auto",
                revision="trusted-revision",
                max_new_tokens=32,
                num_beams=4,
            )
            result = translator.translate(("Hello",))

        self.assertEqual(result, ("Xin chào",))
        self.assertEqual(
            tokenizer_load_calls,
            [(translation.MODEL_NAME, "trusted-revision")],
        )
        self.assertEqual(
            model_load_calls,
            [(translation.MODEL_NAME, "trusted-revision")],
        )
        self.assertEqual(translator._device, "cpu")
        self.assertTrue(translator._model.evaluated)
        self.assertTrue(translator._tokenizer.skip_special_tokens)
        self.assertEqual(translator._model.generate_kwargs["num_beams"], 4)
        self.assertTrue(translator._model.generate_kwargs["early_stopping"])
        self.assertEqual(translator._tokenizer.input_ids.device, "cpu")


class TranslationCliTests(unittest.TestCase):
    def test_cli_exposes_required_input_and_output_directories(self) -> None:
        parser = translation.build_parser()

        arguments = parser.parse_args(
            ["--input-dir", "captioning", "--output-dir", "captioning_vi"]
        )

        self.assertEqual(arguments.input_dir, Path("captioning"))
        self.assertEqual(arguments.output_dir, Path("captioning_vi"))

    def test_cli_rejects_missing_directory_arguments(self) -> None:
        parser = translation.build_parser()

        with self.assertRaises(SystemExit):
            parser.parse_args([])


if __name__ == "__main__":
    unittest.main()
