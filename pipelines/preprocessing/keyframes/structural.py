"""DINOv2 structural features and deterministic structural keyframe helpers.

This module is deliberately independent from the retrieval embedding lane.  It
can be imported on machines without ``torch`` or ``timm``; the optional model
dependencies (and pretrained weights) are touched only when a non-empty image
batch is encoded for the first time.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

import numpy as np


def _validate_rgb_images(images: Sequence[np.ndarray]) -> list[np.ndarray]:
    if isinstance(images, np.ndarray):
        if images.ndim == 3:
            raise ValueError("images must be a sequence/batch of RGB arrays, not one RGB array")
        if images.ndim != 4:
            raise ValueError("an ndarray image batch must have shape (N, H, W, 3)")
        values = list(images)
    else:
        if isinstance(images, (str, bytes)):
            raise TypeError("images must be a sequence of RGB uint8 arrays")
        try:
            values = list(images)
        except TypeError as exc:
            raise TypeError("images must be a sequence of RGB uint8 arrays") from exc

    for index, image in enumerate(values):
        if not isinstance(image, np.ndarray):
            raise TypeError(f"images[{index}] must be a numpy array")
        if image.dtype != np.uint8:
            raise ValueError(f"images[{index}] must have dtype uint8")
        if image.ndim != 3 or image.shape[2] != 3:
            raise ValueError(f"images[{index}] must have shape (H, W, 3) for RGB")
        if image.shape[0] <= 0 or image.shape[1] <= 0:
            raise ValueError(f"images[{index}] must have non-empty spatial dimensions")
    return values


def _normalise_model_output(features: Any, expected_rows: int) -> np.ndarray:
    """Validate a model batch and return finite unit-length float32 rows."""
    array = np.asarray(features)
    if not np.issubdtype(array.dtype, np.number) or np.issubdtype(array.dtype, np.complexfloating):
        raise ValueError("DINOv2 returned non-real feature values")
    if array.ndim != 2 or array.shape[0] != expected_rows or array.shape[1] <= 0:
        raise ValueError(
            "DINOv2 must return a two-dimensional (batch, embedding_dim) array"
        )
    if not np.isfinite(array).all():
        raise ValueError("DINOv2 returned a non-finite embedding")

    # Accumulate the norm in float64 so very small/large finite model outputs do
    # not underflow/overflow before the final, intentionally float32 result.
    work = array.astype(np.float64, copy=False)
    norms = np.linalg.norm(work, axis=1, keepdims=True)
    if not np.isfinite(norms).all() or np.any(norms <= 0.0):
        raise ValueError("DINOv2 returned a zero-length or invalid embedding")
    normalised = (work / norms).astype(np.float32)
    if not np.isfinite(normalised).all():
        raise ValueError("normalised DINOv2 embeddings are not finite")
    return normalised


class _TimmDinoRuntime:
    """Small lazy runtime wrapper; importing this module never imports torch."""

    def __init__(self, model_name: str, device: str, pretrained: bool) -> None:
        try:
            import timm
            import torch
        except ImportError as exc:  # pragma: no cover - depends on optional environment
            raise RuntimeError(
                "DINOv2 embedding requires the optional 'torch' and 'timm' packages"
            ) from exc

        if device == "auto":
            resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            resolved_device = device
        if resolved_device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError(f"DINOv2 device {resolved_device!r} requested but CUDA is unavailable")

        try:
            model = timm.create_model(model_name, pretrained=pretrained, num_classes=0)
            model = model.eval().to(resolved_device)
        except Exception as exc:  # model name, weights, or device failures
            raise RuntimeError(f"could not load DINOv2 model {model_name!r}: {exc}") from exc

        resolver = getattr(timm.data, "resolve_model_data_config", None)
        if resolver is not None:
            data_config = resolver(model)
        else:  # compatibility with older timm releases
            data_config = timm.data.resolve_data_config({}, model=model)

        input_size = tuple(data_config.get("input_size", (3, 518, 518)))
        mean = tuple(data_config.get("mean", (0.485, 0.456, 0.406)))
        std = tuple(data_config.get("std", (0.229, 0.224, 0.225)))
        if len(input_size) != 3 or input_size[0] != 3 or min(input_size[1:]) <= 0:
            raise RuntimeError(f"invalid DINOv2 input size reported by timm: {input_size!r}")
        if len(mean) != 3 or len(std) != 3 or any(value <= 0 for value in std):
            raise RuntimeError("invalid DINOv2 normalisation configuration reported by timm")

        self._torch = torch
        self._model = model
        self._device = resolved_device
        self._height = int(input_size[1])
        self._width = int(input_size[2])
        self._mean = torch.tensor(mean, dtype=torch.float32).view(1, 3, 1, 1)
        self._std = torch.tensor(std, dtype=torch.float32).view(1, 3, 1, 1)

    def encode_batch(self, images: Sequence[np.ndarray]) -> np.ndarray:
        torch = self._torch
        tensors = []
        for image in images:
            tensor = (
                torch.from_numpy(np.ascontiguousarray(image))
                .permute(2, 0, 1)
                .float()
                .div_(255.0)
                .unsqueeze(0)
            )
            try:
                tensor = torch.nn.functional.interpolate(
                    tensor,
                    size=(self._height, self._width),
                    mode="bicubic",
                    align_corners=False,
                    antialias=True,
                )
            except TypeError:  # torch versions predating interpolate(antialias=...)
                tensor = torch.nn.functional.interpolate(
                    tensor,
                    size=(self._height, self._width),
                    mode="bicubic",
                    align_corners=False,
                )
            tensors.append(tensor.squeeze(0))

        batch = torch.stack(tensors).sub_(self._mean).div_(self._std).to(self._device)
        with torch.inference_mode():
            output = self._model(batch)

        if isinstance(output, dict):
            for key in ("x_norm_clstoken", "pooled", "features"):
                if key in output:
                    output = output[key]
                    break
            else:
                raise ValueError("DINOv2 returned a feature dictionary without a pooled feature")
        if isinstance(output, (tuple, list)):
            if not output:
                raise ValueError("DINOv2 returned an empty feature tuple")
            output = output[0]
        if output.ndim == 3:
            # Some DINO implementations expose tokens even with the classifier
            # removed.  The first token is the canonical CLS representation.
            output = output[:, 0, :]
        if output.ndim != 2:
            raise ValueError("DINOv2 returned an unsupported feature tensor shape")
        return output.detach().float().cpu().numpy()


class DinoV2Embedder:
    """Lazy optional DINOv2 image embedder.

    ``encode_images`` accepts RGB ``uint8`` arrays and returns L2-normalised,
    finite ``float32`` embeddings.  Empty input always returns shape ``(0, 0)``
    without importing torch, creating a model, or downloading weights.

    ``runtime_factory`` is a dependency-injection seam for offline tests.  A
    supplied runtime must expose ``encode_batch(images) -> array``.
    """

    def __init__(
        self,
        model_name: str = "vit_small_patch14_dinov2.lvd142m",
        device: str = "auto",
        batch_size: int = 16,
        *,
        pretrained: bool = True,
        runtime_factory: Callable[[], Any] | None = None,
    ) -> None:
        if not isinstance(model_name, str) or not model_name.strip():
            raise ValueError("model_name must be a non-empty string")
        if not isinstance(device, str) or not device.strip():
            raise ValueError("device must be a non-empty string")
        if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size <= 0:
            raise ValueError("batch_size must be a positive integer")
        if not isinstance(pretrained, bool):
            raise ValueError("pretrained must be a boolean")
        if runtime_factory is not None and not callable(runtime_factory):
            raise TypeError("runtime_factory must be callable")

        self.model_name = model_name.strip()
        self.device = device.strip()
        self.batch_size = batch_size
        self.pretrained = pretrained
        self._runtime_factory = runtime_factory
        self._runtime: Any | None = None

    def _get_runtime(self) -> Any:
        if self._runtime is None:
            if self._runtime_factory is None:
                self._runtime = _TimmDinoRuntime(
                    self.model_name,
                    self.device,
                    self.pretrained,
                )
            else:
                self._runtime = self._runtime_factory()
            if not callable(getattr(self._runtime, "encode_batch", None)):
                raise TypeError("DINOv2 runtime must provide encode_batch(images)")
        return self._runtime

    def encode_images(self, images: Sequence[np.ndarray]) -> np.ndarray:
        validated = _validate_rgb_images(images)
        if not validated:
            return np.empty((0, 0), dtype=np.float32)

        runtime = self._get_runtime()
        batches: list[np.ndarray] = []
        embedding_dim: int | None = None
        for start in range(0, len(validated), self.batch_size):
            batch_images = validated[start : start + self.batch_size]
            output = runtime.encode_batch(batch_images)
            normalised = _normalise_model_output(output, len(batch_images))
            if embedding_dim is None:
                embedding_dim = int(normalised.shape[1])
            elif normalised.shape[1] != embedding_dim:
                raise ValueError("DINOv2 embedding dimension changed between batches")
            batches.append(normalised)
        return np.concatenate(batches, axis=0).astype(np.float32, copy=False)


def _normalised_embeddings(embeddings: Any) -> np.ndarray:
    array = np.asarray(embeddings)
    if array.size == 0 and array.ndim == 1:
        array = np.empty((0, 0), dtype=np.float64)
    if array.ndim != 2:
        raise ValueError("embeddings must have shape (N, D)")
    if array.shape[0] > 0 and array.shape[1] == 0:
        raise ValueError("non-empty embeddings must have a positive feature dimension")
    if not np.issubdtype(array.dtype, np.number) or np.issubdtype(array.dtype, np.complexfloating):
        raise ValueError("embeddings must contain real numeric values")
    if not np.isfinite(array).all():
        raise ValueError("embeddings must contain only finite values")
    if array.shape[0] == 0:
        return array.astype(np.float64, copy=False)

    work = array.astype(np.float64, copy=False)
    norms = np.linalg.norm(work, axis=1, keepdims=True)
    if not np.isfinite(norms).all() or np.any(norms <= 0.0):
        raise ValueError("each embedding must have a finite, non-zero norm")
    return work / norms


def _validate_similarity_threshold(value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, np.integer, np.floating)):
        raise ValueError("similarity_threshold must be a finite number between -1 and 1")
    threshold = float(value)
    if not np.isfinite(threshold) or not -1.0 <= threshold <= 1.0:
        raise ValueError("similarity_threshold must be a finite number between -1 and 1")
    return threshold


def _temporal_order(size: int, timestamps: Any | None) -> tuple[list[int], np.ndarray]:
    if timestamps is None:
        values = np.arange(size, dtype=np.float64)
    else:
        values = np.asarray(timestamps)
        if values.shape != (size,):
            raise ValueError("timestamps must have shape (N,) matching embeddings")
        if not np.issubdtype(values.dtype, np.number) or np.issubdtype(
            values.dtype, np.complexfloating
        ):
            raise ValueError("timestamps must contain real numeric values")
        values = values.astype(np.float64, copy=False)
        if not np.isfinite(values).all():
            raise ValueError("timestamps must contain only finite values")
    order = sorted(range(size), key=lambda index: (float(values[index]), index))
    return order, values


def global_structural_dedup(
    embeddings: Any,
    *,
    similarity_threshold: float = 0.95,
    timestamps: Any | None = None,
) -> list[int]:
    """Return temporal representatives after global cosine deduplication.

    A frame is removed when its cosine similarity is at least the threshold to
    *any* earlier retained frame.  This catches recurring A-B-A structures,
    unlike adjacent-only deduplication.  Input row indices are returned, sorted
    by ``timestamps`` (input order is the deterministic tie-breaker).
    """

    vectors = _normalised_embeddings(embeddings)
    threshold = _validate_similarity_threshold(similarity_threshold)
    order, _ = _temporal_order(len(vectors), timestamps)
    kept: list[int] = []
    for index in order:
        if kept:
            similarities = vectors[kept] @ vectors[index]
            if bool(np.any(similarities >= threshold)):
                continue
        kept.append(index)
    return kept


def select_cosine_cluster_medoids(
    embeddings: Any,
    *,
    similarity_threshold: float = 0.80,
    timestamps: Any | None = None,
) -> list[int]:
    """Cluster by cosine connectivity and select one medoid per component.

    Edges connect pairs whose cosine similarity is at least the threshold.  A
    cluster's medoid maximises mean cosine similarity to all cluster members.
    Centrality ties are resolved by the earliest timestamp, then input index;
    returned source indices are likewise in stable temporal order.
    """

    vectors = _normalised_embeddings(embeddings)
    threshold = _validate_similarity_threshold(similarity_threshold)
    order, temporal_values = _temporal_order(len(vectors), timestamps)
    size = len(vectors)
    if size == 0:
        return []

    parent = list(range(size))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root == right_root:
            return
        # Root selection is index-stable, even though cluster membership alone
        # (not the root value) determines the medoid.
        if left_root > right_root:
            left_root, right_root = right_root, left_root
        parent[right_root] = left_root

    for left in range(size):
        for right in range(left + 1, size):
            if float(vectors[left] @ vectors[right]) >= threshold:
                union(left, right)

    clusters: dict[int, list[int]] = {}
    for index in range(size):
        clusters.setdefault(find(index), []).append(index)

    medoids: list[int] = []
    for members in clusters.values():
        member_vectors = vectors[members]
        centralities = (member_vectors @ member_vectors.T).mean(axis=1)
        maximum = float(centralities.max())
        tied = [
            member
            for member, centrality in zip(members, centralities)
            if np.isclose(float(centrality), maximum, rtol=1e-10, atol=1e-12)
        ]
        medoids.append(
            min(tied, key=lambda index: (float(temporal_values[index]), index))
        )

    temporal_rank = {index: rank for rank, index in enumerate(order)}
    return sorted(medoids, key=temporal_rank.__getitem__)


__all__ = [
    "DinoV2Embedder",
    "global_structural_dedup",
    "select_cosine_cluster_medoids",
]
