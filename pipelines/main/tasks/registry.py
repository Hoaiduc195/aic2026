"""Default node registry for the greenfield pipeline."""

from __future__ import annotations

from typing import Any

from pipelines.main.config import DEFAULT_TASKS
from pipelines.main.core.registry import NodeRegistry

from .asr.local import AsrLocalNode
from .captioning.local import CaptioningLocalNode
from .frame_manifest.local import FrameManifestLocalNode
from .ingestion.local import IngestionLocalNode
from .keyframes.local import KeyframesLocalNode
from .modal import ModalNode
from .normalization.local import NormalizationLocalNode
from .object_detection.local import ObjectDetectionLocalNode
from .ocr.local import OcrLocalNode
from .segmentation.local import SegmentationLocalNode
from .shot_detection.local import ShotDetectionLocalNode
from .visual_embedding.local import VisualEmbeddingLocalNode

TASK_DEPENDENCIES = {
    "ingestion": (),
    "frame_manifest": ("ingestion",),
    "shot_detection": ("frame_manifest",),
    "segmentation": ("shot_detection",),
    "keyframes": ("frame_manifest", "segmentation"),
    "visual_embedding": ("keyframes",),
    "asr": ("segmentation",),
    "ocr": ("keyframes",),
    "object_detection": ("keyframes",),
    "captioning": ("keyframes",),
    "normalization": ("asr", "captioning", "keyframes", "object_detection", "ocr", "visual_embedding"),
}


def build_registry(*, artifact_store: Any) -> NodeRegistry:
    """Build all task/provider slots without importing model libraries eagerly."""

    registry = NodeRegistry()
    local_nodes = (
        IngestionLocalNode(artifact_store=artifact_store),
        FrameManifestLocalNode(artifact_store=artifact_store),
        ShotDetectionLocalNode(artifact_store=artifact_store),
        SegmentationLocalNode(artifact_store=artifact_store),
        KeyframesLocalNode(artifact_store=artifact_store),
        VisualEmbeddingLocalNode(artifact_store=artifact_store),
        AsrLocalNode(artifact_store=artifact_store),
        OcrLocalNode(artifact_store=artifact_store),
        ObjectDetectionLocalNode(artifact_store=artifact_store),
        CaptioningLocalNode(artifact_store=artifact_store),
        NormalizationLocalNode(artifact_store=artifact_store),
    )
    for node in local_nodes:
        registry.register(node)
    for task_name in DEFAULT_TASKS:
        registry.register(
            ModalNode(
                task_name,
                artifact_store=artifact_store,
                dependencies=TASK_DEPENDENCIES[task_name],
            )
        )
    return registry
