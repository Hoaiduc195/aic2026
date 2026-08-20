# TDD evidence: PaddleOCR detection options compatibility

## User journey

- A Modal OCR worker starts with PaddleOCR 3.7.
- `TextDetection` receives only options supported by the installed PaddleOCR
  API, so model loading does not fail before the first image is processed.

## Evidence

| Guarantee | Test or command | Result |
|---|---|---|
| The detector options do not contain the removed `max_side_limit` argument | `python -m unittest tests.test_ocr_modal.OcrPlanningTests.test_detection_options_match_paddleocr_37_api` | PASS |
| The OCR module remains syntactically valid | `python -m py_compile pipelines/feature_extraction/ocr/modal_paddleocr.py` | PASS |
| Python lint | `ruff check pipelines/feature_extraction/ocr/modal_paddleocr.py tests/test_ocr_modal.py` | PASS |

## RED/GREEN history

- RED: the new regression test failed because `build_detection_options` did
  not exist.
- GREEN: the detector options are now built centrally and no longer include
  `max_side_limit`; the focused regression test passes.

## Known gap

The full `tests.test_ocr_modal` module still has one unrelated pre-existing
failure: the test expects `DEFAULT_GPU_TYPE == "T4"`, while the current OCR
configuration is `"L4"`. This fix does not change the selected GPU type.

No paid Modal GPU run was started automatically.
