from __future__ import annotations

import unittest

from apps.inference.src.service import EncodeTextRequest, InferenceService


class InferenceServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = InferenceService(
            allowed_models={"mock-multilingual": "2026-07"},
            dimensions={"mock-multilingual": 8},
        )

    def test_encoding_is_deterministic_and_normalized(self) -> None:
        request = EncodeTextRequest(
            request_id="req-1",
            text="xe buýt màu xanh",
            model_family="mock-multilingual",
            model_revision="2026-07",
            deadline_ms=1000,
        )

        first = self.service.encode_text(request)
        second = self.service.encode_text(request)

        self.assertEqual(first.embedding, second.embedding)
        self.assertEqual(8, first.dimension)
        self.assertAlmostEqual(1.0, sum(value * value for value in first.embedding), places=6)
        self.assertEqual("completed", first.status)

    def test_rejects_unknown_or_mismatched_model_revision(self) -> None:
        with self.assertRaises(ValueError):
            self.service.encode_text(
                EncodeTextRequest(
                    request_id="req-2",
                    text="person entering a shop",
                    model_family="mock-multilingual",
                    model_revision="stale",
                    deadline_ms=1000,
                )
            )

    def test_rejects_empty_text_and_invalid_deadline(self) -> None:
        for text, deadline in (("", 100), ("query", 0)):
            with self.subTest(text=text, deadline=deadline), self.assertRaises(ValueError):
                EncodeTextRequest(
                    request_id="req-3",
                    text=text,
                    model_family="mock-multilingual",
                    model_revision="2026-07",
                    deadline_ms=deadline,
                )


if __name__ == "__main__":
    unittest.main()
