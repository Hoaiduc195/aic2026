# TDD evidence: local caption translation

## Source plan

The implementation follows the conversational plan for a local,
English-to-Vietnamese caption translator with configurable input/output
directories, batching, deduplication, resume support, and parallel partitions.

## User journeys

- As a pipeline operator, I want to choose the English input folder and
  Vietnamese output folder from the command line, so the script works with any
  dataset location.
- As a pipeline operator, I want repeated captions translated only once, so a
  large caption set uses fewer model inference calls.
- As a pipeline operator, I want existing output files skipped and partitions
  deterministic, so interrupted or parallel runs can resume safely.

## RED/GREEN evidence

| Stage | Command | Result |
|---|---|---|
| RED | `python -m unittest tests.test_translation_captions -v` | Failed because `translate_captions` did not exist. |
| GREEN | `python -m unittest tests.test_translation_captions tests.test_captioning_modal` | 26 tests passed. |
| Lint | `ruff check pipelines/feature_extraction/captioning/translate_captions.py tests/test_translation_captions.py` | Passed. |
| CLI | `python -m pipelines.feature_extraction.captioning.translate_captions --help` | Passed; required `--input-dir` and `--output-dir` are exposed. |

## Guarantees

| Behavior | Test coverage |
|---|---|
| Natural ordering and deterministic near-equal partitions | `TranslationPathTests` |
| Input/output directory safety and parallel layout preservation | `TranslationPathTests`, `TranslationBatchTests` |
| Duplicate caption deduplication before batched inference | `test_translate_directory_deduplicates_and_preserves_parallel_layout` |
| Resume behavior, empty captions, and UTF-8 output | `test_translate_directory_resumes_existing_and_writes_empty_outputs` |
| Model revision forwarding and batched generation options | `HuggingFaceTranslatorTests` |
| Required configurable CLI directories | `TranslationCliTests` |

## Coverage and known gaps

The focused suite and lint pass. The repository-wide unittest discovery run
executed 90 tests but could not import 11 existing preprocessing test modules
because the current environment lacks pre-existing packages such as `numpy`,
`pandas`, and `av`; those failures are unrelated to this feature. The
`coverage` package is not installed, so a numeric coverage report was not
available. Actual Hugging Face model inference remains an environment smoke
test because the test suite injects fake model dependencies and does not
download weights.
