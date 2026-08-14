from __future__ import annotations

from pipelines.main.contracts.validation import validate_records
from pipelines.main.core.models import NodeContext, NodeResult
from pipelines.main.tasks.base import TaskNode
from pipelines.main.tasks.io import first_artifact_path, jsonl_bytes, read_jsonl
from pipelines.main.tasks.video import decode_frames, require_cv2


class KeyframesLocalNode(TaskNode):
    task_name = "keyframes"
    provider = "local"
    dependencies = ("frame_manifest", "segmentation")

    async def run(self, context: NodeContext) -> NodeResult:
        frames = read_jsonl(first_artifact_path(context.artifacts["frame_manifest"]))
        segments = read_jsonl(first_artifact_path(context.artifacts["segmentation"]))
        if not frames or not segments:
            return NodeResult.failed(self.task_name, self.provider, "missing_timeline", "frames and segments are required")

        frame_by_id = {int(frame["original_frame_id"]): frame for frame in frames}
        selected: dict[int, tuple[str, int]] = {}
        for index, segment in enumerate(segments):
            start = int(segment["start_frame_id"])
            end = max(start + 1, int(segment["end_frame_id"]))
            candidate_ids = list(range(start, min(end, start + 3)))
            if not candidate_ids:
                continue
            candidate = max(candidate_ids, key=lambda frame_id: _quality(frame_by_id.get(frame_id, {})))
            selected[candidate] = (str(segment["segment_id"]), index)

        cv2 = require_cv2()
        keyframe_rows: list[dict[str, object]] = []
        output_root = self.artifact_store.root
        for frame_record, image in decode_frames(self._input_path(context), context.artifacts["ingestion"].metrics["manifest"]):
            frame_id = int(frame_record["original_frame_id"])
            if frame_id not in selected:
                continue
            segment_id, ordinal = selected[frame_id]
            encoded_ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
            if not encoded_ok:
                continue
            relative_path = f"keyframes/{context.video_id}/{ordinal:06d}.jpg"
            image_artifact = self.artifact_store.write_bytes(
                run_id=context.run_id,
                artifact_type="keyframe-image",
                relative_path=relative_path,
                payload=encoded.tobytes(),
                schema_name="keyframe",
                schema_version="1.0.0",
                dataset_id=context.config.dataset_id,
                dataset_version=context.config.dataset_version,
                content_type="image/jpeg",
            )
            row = {
                "video_id": context.video_id,
                "original_frame_id": frame_id,
                "decoded_frame_index": frame_id,
                "timestamp_ms": int(frame_record["timestamp_ms"]),
                "storage_uri": image_artifact.uri,
                "source_storage_uri": self._input_path(context).resolve().as_uri(),
                "segment_id": segment_id,
                "shot_id": ordinal,
                "n": ordinal + 1,
                "frame_idx": frame_id,
                "pts_time": float(frame_record["timestamp_ms"]) / 1000.0,
                "fps": f"{frame_record['fps_num']}/{frame_record['fps_den']}",
                "path": str(output_root / relative_path),
                "retrieval_roles": ["shot_anchor"],
                "quality_scores": {
                    key: frame_record[key]
                    for key in (
                        "brightness_score",
                        "blur_score",
                        "contrast_score",
                        "entropy_score",
                        "motion_score",
                        "scene_change_score",
                        "text_change_score",
                    )
                },
                "quality_route": "retrieval_embedding",
                "selected_for_retrieval": True,
                "eligible_for_embedding": True,
                "quality_ok": True,
                "pipeline_version": "main-v1.0.0",
                "schema_version": "1.0.0",
            }
            keyframe_rows.append(row)

        if not keyframe_rows:
            return NodeResult.failed(self.task_name, self.provider, "no_keyframes", "no keyframes could be encoded")
        validate_records("keyframe", keyframe_rows)
        table_artifact = self.artifact_store.write_bytes(
            run_id=context.run_id,
            artifact_type="keyframe-manifest",
            relative_path=f"canonical/{context.video_id}/keyframes.jsonl",
            payload=jsonl_bytes(keyframe_rows),
            schema_name="keyframe",
            schema_version="1.0.0",
            dataset_id=context.config.dataset_id,
            dataset_version=context.config.dataset_version,
            record_count=len(keyframe_rows),
            content_type="application/jsonl",
        )
        return NodeResult.completed(self.task_name, self.provider, artifacts=(table_artifact,), metrics={"keyframe_count": len(keyframe_rows)})


def _quality(frame: dict[str, object]) -> float:
    return (
        float(frame.get("blur_score", 0.0))
        + float(frame.get("contrast_score", 0.0))
        + float(frame.get("entropy_score", 0.0))
    )
