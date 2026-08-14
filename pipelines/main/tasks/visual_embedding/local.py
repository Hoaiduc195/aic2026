from __future__ import annotations

import io
from typing import Any

from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl


class VisualEmbeddingLocalNode(TaskNode):
    task_name = "visual_embedding"
    provider = "local"
    dependencies = ("keyframes",)

    def __init__(self, *, artifact_store: Any) -> None:
        super().__init__(artifact_store=artifact_store)
        self._model_bundle: tuple[Any, Any, Any] | None = None

    async def run(self, context: NodeContext) -> NodeResult:
        try:
            import numpy as np
            import open_clip
            import torch
            from PIL import Image
        except ImportError:
            return NodeResult.failed(
                self.task_name,
                self.provider,
                "missing_embedding_dependency",
                "visual embedding requires open_clip_torch, torch and Pillow",
            )

        rows = read_jsonl(first_artifact_path(context.artifacts["keyframes"]))
        if not rows:
            return NodeResult.failed(self.task_name, self.provider, "no_keyframes", "keyframe manifest is empty")
        model_name = str(context.config.node(self.task_name).options.get("model", "ViT-B-16-SigLIP"))
        pretrained = str(context.config.node(self.task_name).options.get("pretrained", "webli"))
        device = str(context.config.node(self.task_name).options.get("device", "cuda" if torch.cuda.is_available() else "cpu"))
        try:
            if self._model_bundle is None:
                model, _, preprocess = open_clip.create_model_and_transforms(model_name, pretrained=pretrained, device=device)
                model.eval()
                self._model_bundle = (model, preprocess, torch.device(device))
            model, preprocess, torch_device = self._model_bundle
            batch_size = max(1, int(context.config.node(self.task_name).options.get("batch_size", 32)))
            vectors: list[Any] = []
            for start in range(0, len(rows), batch_size):
                batch_rows = rows[start : start + batch_size]
                images = torch.stack([preprocess(Image.open(str(row["path"])).convert("RGB")) for row in batch_rows]).to(torch_device)
                with torch.inference_mode():
                    encoded = model.encode_image(images)
                    encoded = encoded / encoded.norm(dim=-1, keepdim=True).clamp_min(1e-12)
                vectors.append(encoded.float().cpu().numpy())
        except Exception as error:  # noqa: BLE001 - model boundary
            return NodeResult.failed(self.task_name, self.provider, "embedding_inference_failed", str(error))

        matrix = np.concatenate(vectors, axis=0).astype(np.float16, copy=False)
        buffer = io.BytesIO()
        np.save(buffer, matrix, allow_pickle=False)
        matrix_artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="visual-embedding-matrix",
            relative_path=f"canonical/{context.video_id}/embeddings.npy",
            payload=buffer.getvalue(),
            schema_name="embedding_result",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(rows),
            content_type="application/octet-stream",
        )
        records = [
            {
                "video_id": context.video_id,
                "segment_id": str(row.get("segment_id") or f"{context.video_id}-seg-unknown"),
                "original_frame_id": int(row["original_frame_id"]),
                "timestamp_ms": int(row["timestamp_ms"]),
                "embedding_id": f"{context.video_id}:{int(row['original_frame_id'])}",
                "embedding_uri": matrix_artifact.uri,
                "embedding_dim": int(matrix.shape[1]),
                "dtype": "float16",
                "normalized": True,
                "model_name": model_name,
                "model_version": pretrained,
                "pipeline_version": "main-v1.0.0",
                "schema_version": "1.0.0",
            }
            for row in rows
        ]
        from pipelines.main.contracts.validation import validate_records

        validate_records("embedding_result", records)
        table_artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="visual-embedding-index",
            relative_path=f"canonical/{context.video_id}/embeddings.jsonl",
            payload=jsonl_bytes(records),
            schema_name="embedding_result",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(records),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(matrix_artifact, table_artifact), metrics={"embedding_count": len(rows), "embedding_dim": int(matrix.shape[1])})
