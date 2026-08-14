from __future__ import annotations

import unittest
from pathlib import Path


class ArchitectureBoundaryTests(unittest.TestCase):
    def test_new_pipeline_does_not_import_legacy_pipeline_packages(self) -> None:
        root = Path(__file__).resolve().parents[1]
        forbidden = ("pipelines.preprocessing", "pipelines.feature_extraction")
        for path in root.rglob("*.py"):
            if path == Path(__file__):
                continue
            text = path.read_text(encoding="utf-8")
            for package in forbidden:
                self.assertNotIn(package, text, f"legacy import in {path}")


if __name__ == "__main__":
    unittest.main()
