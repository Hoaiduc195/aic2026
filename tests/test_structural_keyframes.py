import builtins
import unittest
from unittest import mock

import numpy as np

from pipelines.preprocessing.keyframes.structural import (
    DinoV2Embedder,
    global_structural_dedup,
    select_cosine_cluster_medoids,
)


class _FakeDinoRuntime:
    def __init__(self, batches):
        self._batches = iter(batches)
        self.calls = []

    def encode_batch(self, images):
        self.calls.append(len(images))
        return next(self._batches)


class DinoV2EmbedderTest(unittest.TestCase):
    def test_empty_input_is_stable_and_does_not_import_model_dependencies(self):
        created = []
        embedder = DinoV2Embedder(runtime_factory=lambda: created.append(True))
        real_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name.split(".", 1)[0] in {"torch", "timm"}:
                raise AssertionError("model dependency imported for empty input")
            return real_import(name, *args, **kwargs)

        with mock.patch("builtins.__import__", side_effect=guarded_import):
            first = embedder.encode_images([])
            second = embedder.encode_images(np.empty((0, 4, 5, 3), dtype=np.uint8))

        self.assertEqual(first.shape, (0, 0))
        self.assertEqual(second.shape, (0, 0))
        self.assertEqual(first.dtype, np.float32)
        self.assertEqual(created, [])

    def test_batches_normalises_to_finite_float32_and_loads_runtime_once(self):
        runtime = _FakeDinoRuntime([
            np.array([[3.0, 4.0], [0.0, 2.0]], dtype=np.float64),
            np.array([[1.0, 1.0]], dtype=np.float64),
        ])
        loads = []

        def factory():
            loads.append(True)
            return runtime

        frames = [np.zeros((3, 5, 3), dtype=np.uint8) for _ in range(3)]
        result = DinoV2Embedder(batch_size=2, runtime_factory=factory).encode_images(frames)

        self.assertEqual(loads, [True])
        self.assertEqual(runtime.calls, [2, 1])
        self.assertEqual(result.dtype, np.float32)
        self.assertEqual(result.shape, (3, 2))
        np.testing.assert_allclose(np.linalg.norm(result, axis=1), 1.0, atol=1e-6)
        self.assertTrue(np.isfinite(result).all())
        np.testing.assert_allclose(result[0], [0.6, 0.8], atol=1e-6)

    def test_rejects_invalid_rgb_before_loading_runtime(self):
        loaded = []
        embedder = DinoV2Embedder(runtime_factory=lambda: loaded.append(True))

        invalid = [
            np.zeros((4, 5), dtype=np.uint8),
            np.zeros((4, 5, 4), dtype=np.uint8),
            np.zeros((4, 5, 3), dtype=np.float32),
            np.zeros((0, 5, 3), dtype=np.uint8),
        ]
        for image in invalid:
            with self.subTest(shape=image.shape, dtype=image.dtype):
                with self.assertRaises(ValueError):
                    embedder.encode_images([image])
        with self.assertRaises(ValueError):
            embedder.encode_images(np.zeros((4, 5, 3), dtype=np.uint8))
        self.assertEqual(loaded, [])

    def test_rejects_nonfinite_zero_and_inconsistent_model_output(self):
        frame = np.zeros((2, 2, 3), dtype=np.uint8)
        for output in (
            np.array([[np.inf, 1.0]]),
            np.array([[0.0, 0.0]]),
            np.array([1.0, 2.0]),
        ):
            with self.subTest(output=output):
                embedder = DinoV2Embedder(
                    runtime_factory=lambda output=output: _FakeDinoRuntime([output])
                )
                with self.assertRaises(ValueError):
                    embedder.encode_images([frame])

        runtime = _FakeDinoRuntime([np.ones((1, 2)), np.ones((1, 3))])
        embedder = DinoV2Embedder(batch_size=1, runtime_factory=lambda: runtime)
        with self.assertRaisesRegex(ValueError, "dimension changed"):
            embedder.encode_images([frame, frame])

    def test_validates_configuration(self):
        for kwargs in (
            {"model_name": ""},
            {"device": ""},
            {"batch_size": 0},
            {"batch_size": True},
            {"pretrained": 1},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    DinoV2Embedder(**kwargs)


class StructuralSelectionTest(unittest.TestCase):
    def test_global_dedup_is_global_and_uses_temporal_order(self):
        embeddings = np.array([
            [1.0, 0.0],      # latest A
            [0.0, 1.0],      # middle B
            [0.99, 0.01],    # earliest A: representative of recurring A
            [-1.0, 0.0],     # distinct C
        ])

        kept = global_structural_dedup(
            embeddings,
            similarity_threshold=0.95,
            timestamps=[30.0, 20.0, 10.0, 40.0],
        )

        self.assertEqual(kept, [2, 1, 3])

    def test_global_dedup_temporal_ties_fall_back_to_input_index(self):
        embeddings = np.array([[1.0, 0.0], [1.0, 0.0], [0.0, 1.0]])
        self.assertEqual(
            global_structural_dedup(
                embeddings,
                similarity_threshold=1.0,
                timestamps=[4.0, 4.0, 3.0],
            ),
            [2, 0],
        )

    def test_cluster_medoid_selects_central_member_and_orders_temporally(self):
        embeddings = np.array([
            [1.0, 0.0],
            [0.8, 0.6],       # central member of the first component
            [0.28, 0.96],
            [-1.0, 0.0],      # singleton component, earlier in time
        ])

        medoids = select_cosine_cluster_medoids(
            embeddings,
            similarity_threshold=0.70,
            timestamps=[20.0, 30.0, 40.0, 10.0],
        )

        self.assertEqual(medoids, [3, 1])

    def test_cluster_medoid_tie_uses_earliest_timestamp_then_index(self):
        embeddings = np.array([[1.0, 0.0], [0.9, 0.1]])
        self.assertEqual(
            select_cosine_cluster_medoids(
                embeddings,
                similarity_threshold=0.9,
                timestamps=[8.0, 7.0],
            ),
            [1],
        )
        self.assertEqual(
            select_cosine_cluster_medoids(
                embeddings,
                similarity_threshold=0.9,
                timestamps=[7.0, 7.0],
            ),
            [0],
        )

    def test_selection_validates_embeddings_thresholds_and_timestamps(self):
        functions = (global_structural_dedup, select_cosine_cluster_medoids)
        bad_embeddings = (
            [1.0, 2.0],
            np.array([[np.nan, 0.0]]),
            np.array([[0.0, 0.0]]),
            np.empty((1, 0)),
            np.array([[1.0 + 1.0j, 0.0]]),
        )
        for function in functions:
            self.assertEqual(function(np.empty((0, 4))), [])
            self.assertEqual(function([]), [])
            for embeddings in bad_embeddings:
                with self.subTest(function=function.__name__, embeddings=embeddings):
                    with self.assertRaises(ValueError):
                        function(embeddings)
            for threshold in (np.nan, -1.1, 1.1, True):
                with self.subTest(function=function.__name__, threshold=threshold):
                    with self.assertRaises(ValueError):
                        function([[1.0, 0.0]], similarity_threshold=threshold)
            with self.assertRaises(ValueError):
                function([[1.0, 0.0]], timestamps=[])
            with self.assertRaises(ValueError):
                function([[1.0, 0.0]], timestamps=[np.inf])


if __name__ == "__main__":
    unittest.main()
