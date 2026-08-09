import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from pipelines.preprocessing.io_utils import (
    atomic_output_path,
    write_json_atomic,
    write_parquet_atomic,
)


class AtomicCheckpointIoTest(unittest.TestCase):
    def test_success_replaces_target_and_failure_preserves_previous_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "checkpoint.json"
            write_json_atomic({"version": 1}, target)
            self.assertEqual(json.loads(target.read_text()), {"version": 1})

            with self.assertRaises(RuntimeError):
                with atomic_output_path(target) as temporary:
                    temporary.write_text('{"version": 2}', encoding="utf-8")
                    raise RuntimeError("interrupted")

            self.assertEqual(json.loads(target.read_text()), {"version": 1})
            self.assertEqual([], list(target.parent.glob(".*.tmp.json")))

    def test_parquet_is_readable_after_atomic_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "rows.parquet"
            expected = pd.DataFrame({"frame_id": [0, 1], "score": [0.2, 0.8]})
            write_parquet_atomic(expected, target)
            pd.testing.assert_frame_equal(pd.read_parquet(target), expected)


if __name__ == "__main__":
    unittest.main()
