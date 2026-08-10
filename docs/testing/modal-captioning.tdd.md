# TDD evidence: Modal Florence-2 captioning

## Source and user journeys

The implementation was derived from the approved Modal captioning plan in the
conversation. The main journeys are:

- A team member selects one deterministic 291-video partition from 873 videos.
- A local input folder is streamed to one Modal T4 worker and captions are
  written to a separate local output folder.
- Rerunning a job skips existing caption files, retains a JSONL progress manifest,
  isolates malformed images, and stops at a configured cost estimate.

## Evidence

| Guarantee | Test or command | Result |
|---|---|---|
| 873 videos split into three disjoint groups of 291 | `python -m unittest tests.test_captioning_modal -v` | PASS |
| Frame ordering, output mapping, resume, path traversal and directory layout | `tests.test_captioning_modal` | PASS |
| Modal result validation and isolateable-image recovery | `tests.test_captioning_modal` | PASS |
| Immutable cost tracker and budget estimate | `tests.test_captioning_modal` | PASS |
| Actual data layout resolves to 291/873 videos and 74,043 frames | read-only `caption_directory(..., dry_run=True)` | PASS |
| Python lint | `ruff check pipelines/feature_extraction/captioning tests/test_captioning_modal.py` | PASS |
| Python syntax/bytecode | `python -m compileall -q pipelines/feature_extraction/captioning tests/test_captioning_modal.py` | PASS |
| Modal SDK app definition | Modal SDK 1.5.3 import smoke | PASS |
| Relevant repository regression suite | 69 tests across captioning, ASR, contracts and video source | PASS |

## RED/GREEN history

- RED: the new test target failed because
  `modal_florence_captioning` did not exist.
- GREEN: the initial implementation passed 9/9 captioning tests.
- GREEN after remote protocol/recovery tests: 13/13.
- GREEN after directory-layout validation: 14/14.
- GREEN after Windows narrow-console regression fix: 15/15.

## Known gaps

- The full repository discovery run cannot import 11 existing preprocessing
  test modules in this environment because `pandas`, `numpy`, or `av` are not
  installed. The implementation does not add those dependencies locally.
- `coverage` and `pyright` are not installed, so no coverage percentage or
  static type-check result is claimed.
- No paid Modal GPU pilot was started automatically. The first real run must
  use `--max-images 500` without `--dry-run`, then review captions and measure
  throughput before processing the full partition.
