"""Stream keyframes to Modal GPU running CLIPA-v2 (ViT-H/14) for visual embedding extraction.

The local orchestrator reads keyframe archives (.zip), manifests, or image folders,
sends batches of image bytes to a Modal GPU worker running CLIPA-v2 ViT-H/14,
and writes L2-normalized .npy matrices and EmbeddingResult .parquet manifests.

Example:
    modal run pipelines/feature_extraction/visual_embedding/modal_clip_embedding.py \\
        --input-dir C:/Users/Admin/Downloads/archive.zip \\
        --output-dir D:/AI Challenge/aic2026/data/embeddings \\
        --budget-usd 30
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
import zipfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, List, Optional, Tuple, Union

try:
    import modal
except ModuleNotFoundError:
    modal = None

import numpy as np
import pandas as pd
from PIL import Image

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("modal_clip_embedding")

MODEL_NAME = "hf-hub:UCSC-VLAA/ViT-H-14-CLIPA-336-laion2B"
PIPELINE_VERSION = "visual-embedding-clipa-v2-h14"
GPU_TYPE = "A10G"
GPU_RATE_USD_PER_HOUR = 1.10
GPU_BATCH_SIZE = 64
DEFAULT_SUBMISSION_WINDOW = 256
MAX_IMAGE_BYTES = 20 * 1024 * 1024
DEFAULT_CONCURRENCY = 4

IMAGE_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".webp", ".bmp"})


def safe_print(message: str) -> None:
    """Print message handling UTF-8 stdout safely."""
    try:
        print(message)
    except UnicodeEncodeError:
        print(message.encode("utf-8", errors="replace").decode("ascii", errors="replace"))


@dataclass(frozen=True)
class LocalKeyframeItem:
    video_id: str
    original_frame_id: int
    image_path: Optional[Path] = None
    zip_path: Optional[Path] = None
    zip_member: Optional[str] = None
    timestamp_ms: Optional[int] = None
    segment_id: str = ""
    frame_id: Optional[str] = None
    dataset_id: Optional[str] = None
    dataset_version: Optional[str] = None


@dataclass(frozen=True)
class RunConfig:
    input_dir: Path
    output_dir: Path
    model_name: str = MODEL_NAME
    budget_usd: float = 30.0
    overwrite: bool = False
    submission_window: int = DEFAULT_SUBMISSION_WINDOW
    concurrency: int = DEFAULT_CONCURRENCY
    dry_run: bool = False
    dtype: str = "float32"
    video_ids: Optional[list[str]] = None


def discover_keyframes(input_path: Path) -> dict[str, list[LocalKeyframeItem]]:
    """
    Discover keyframes grouped by video_id from input directory or zip archive.
    Supports:
    1. A .zip archive (e.g. archive.zip) containing keyframe folders.
    2. Directory containing <video_id>.parquet manifest files.
    3. Directory structured by <video_id>/<frame_id>.(webp|jpg|png).
    """
    grouped: dict[str, list[LocalKeyframeItem]] = {}

    if input_path.is_file() and input_path.suffix.lower() == ".zip":
        with zipfile.ZipFile(input_path, "r") as zf:
            entries = [n for n in zf.namelist() if not n.endswith("/")]
            by_video: dict[str, list[str]] = {}
            for name in entries:
                parts = name.split("/")
                if len(parts) >= 2:
                    video_id = parts[-2]
                    filename = parts[-1]
                    ext = "." + filename.split(".")[-1].lower() if "." in filename else ""
                    if ext in IMAGE_EXTENSIONS:
                        by_video.setdefault(video_id, []).append(name)

            for video_id, members in by_video.items():
                def sort_key(m: str) -> int:
                    stem = m.split("/")[-1].rsplit(".", 1)[0]
                    return int(stem) if stem.isdigit() else hash(stem)

                members.sort(key=sort_key)
                items = []
                for idx, member in enumerate(members):
                    stem = member.split("/")[-1].rsplit(".", 1)[0]
                    if stem.isdigit():
                        val = int(stem)
                        # Dataset keyframes starting at 001.jpg are 1-based, timestamp_ms = (val - 1) * 1000
                        orig_id = val - 1 if val >= 1 else val
                    else:
                        orig_id = idx
                    ts_ms = orig_id * 1000
                    items.append(
                        LocalKeyframeItem(
                            video_id=video_id,
                            original_frame_id=orig_id,
                            timestamp_ms=ts_ms,
                            zip_path=input_path,
                            zip_member=member,
                            segment_id=video_id,
                        )
                    )
                if items:
                    grouped[video_id] = items
        return grouped

    parquet_files = sorted(list(input_path.glob("*.parquet"))) if input_path.is_dir() else []

    if parquet_files:
        for pq_file in parquet_files:
            video_id = pq_file.stem
            try:
                df = pd.read_parquet(pq_file)
                items = []
                for _, row in df.iterrows():
                    orig_id = int(row.get("original_frame_id", row.get("decoded_frame_index", 0)))
                    ts_ms = int(row.get("timestamp_ms", 0))
                    storage_uri = str(row.get("storage_uri", row.get("path", "")))
                    if storage_uri.startswith("file://"):
                        storage_uri = storage_uri[7:]
                        if os.name == "nt" and storage_uri.startswith("/"):
                            storage_uri = storage_uri[1:]
                    img_path = Path(storage_uri)
                    if not img_path.is_absolute():
                        img_path = input_path / img_path

                    seg_id = str(row.get("segment_id", video_id))
                    frame_id_val = str(row.get("frame_id", "")) if "frame_id" in row else None

                    items.append(
                        LocalKeyframeItem(
                            video_id=video_id,
                            original_frame_id=orig_id,
                            timestamp_ms=ts_ms,
                            image_path=img_path,
                            segment_id=seg_id,
                            frame_id=frame_id_val,
                            dataset_id=row.get("dataset_id"),
                            dataset_version=row.get("dataset_version"),
                        )
                    )
                if items:
                    grouped[video_id] = items
            except Exception as e:
                logger.warning(f"Could not read keyframes from {pq_file}: {e}")
    elif input_path.is_dir():
        for root, _, files in os.walk(input_path):
            root_path = Path(root)
            if root_path == input_path:
                continue
            video_id = root_path.name
            items = []
            for file_name in sorted(files):
                file_path = root_path / file_name
                if file_path.suffix.lower() in IMAGE_EXTENSIONS:
                    stem = file_path.stem
                    try:
                        frame_id = int(stem)
                        orig_id = frame_id - 1 if frame_id >= 1 else frame_id
                    except ValueError:
                        orig_id = len(items)
                    items.append(
                        LocalKeyframeItem(
                            video_id=video_id,
                            original_frame_id=orig_id,
                            timestamp_ms=orig_id * 1000,
                            image_path=file_path,
                            segment_id=video_id,
                        )
                    )
            if items:
                grouped[video_id] = items

    return grouped


def save_embedding_results(
    output_dir: Path,
    video_id: str,
    embeddings: np.ndarray,
    items: Sequence[LocalKeyframeItem],
    model_name: str,
    pipeline_version: str = PIPELINE_VERSION,
    dtype: str = "float32",
) -> Tuple[Path, Path]:
    """Save .npy embeddings and .parquet metadata manifest without embedding_id / timestamp_ms."""
    output_dir.mkdir(parents=True, exist_ok=True)
    npy_path = output_dir / f"{video_id}.npy"
    pq_path = output_dir / f"{video_id}.parquet"

    np.save(npy_path, embeddings.astype(np.float32 if dtype == "float32" else np.float16))

    records = []
    dim = int(embeddings.shape[1]) if len(embeddings.shape) > 1 else 0
    embedding_uri = f"file:///{npy_path.resolve().as_posix()}"

    for item in items:
        seg_id = item.segment_id if item.segment_id else item.video_id
        rec = {
            "video_id": item.video_id,
            "segment_id": seg_id,
            "embedding_uri": embedding_uri,
            "embedding_dim": dim,
            "model_name": model_name,
            "model_version": pipeline_version,
            "original_frame_id": int(item.original_frame_id),
            "dtype": dtype,
            "normalized": True,
            "pipeline_version": pipeline_version,
            "schema_version": "1.0.0",
        }
        if item.frame_id:
            rec["frame_id"] = item.frame_id
        if item.dataset_id:
            rec["dataset_id"] = item.dataset_id
        if item.dataset_version:
            rec["dataset_version"] = item.dataset_version
        records.append(rec)

    df = pd.DataFrame(records)
    df.to_parquet(pq_path, index=False)
    return npy_path, pq_path


# Modal App & GPU Worker Definition
app = None
ModalClipEncoder: Any = None

if modal is not None:
    MODEL_CACHE_DIR = "/root/.cache/huggingface"
    model_cache = modal.Volume.from_name("aic-clipa-model-cache", create_if_missing=True)

    image = (
        modal.Image.debian_slim(python_version="3.11")
        .uv_pip_install(
            "torch>=2.2,<3",
            "open_clip_torch>=2.24.0",
            "transformers>=4.49.0",
            "Pillow>=10,<13",
            "timm",
            "numpy",
            "pandas",
            "pyarrow",
        )
        .env({
            "HF_HOME": MODEL_CACHE_DIR,
            "HF_HUB_CACHE": f"{MODEL_CACHE_DIR}/hub",
        })
    )

    app = modal.App(
        "aic-clipa-visual-embedding",
        image=image,
        volumes={MODEL_CACHE_DIR: model_cache},
    )

    @app.cls(
        gpu=GPU_TYPE,
        memory=16_384,
        timeout=12 * 60 * 60,
        scaledown_window=300,
        max_containers=4,
    )
    class ModalClipEncoder:
        """Long-lived Modal GPU worker running CLIPA-v2 ViT-H/14."""

        @modal.enter()
        def load_model(self) -> None:
            import open_clip
            import torch

            self.torch = torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            safe_print(f"Loading CLIPA-v2 model {MODEL_NAME} on {self.device}...")

            self.model, _, self.preprocess = open_clip.create_model_and_transforms(
                MODEL_NAME,
                device=self.device,
                cache_dir=MODEL_CACHE_DIR,
            )
            self.model.eval()
            model_cache.commit()
            safe_print(f"Loaded {MODEL_NAME} on {self.device} successfully.")

        @modal.method()
        def encode_images(self, image_bytes_list: list[bytes], batch_size: int = GPU_BATCH_SIZE) -> bytes:
            """Process image bytes and return raw float32 bytes for zero-overhead transfer."""
            import torch
            from PIL import Image

            all_features = []
            for i in range(0, len(image_bytes_list), batch_size):
                chunk = image_bytes_list[i : i + batch_size]
                tensors = []
                for b in chunk:
                    img = Image.open(BytesIO(b)).convert("RGB")
                    tensors.append(self.preprocess(img))

                batch_tensor = torch.stack(tensors).to(self.device)

                with torch.no_grad(), torch.amp.autocast(device_type="cuda" if self.device == "cuda" else "cpu", dtype=torch.float16):
                    features = self.model.encode_image(batch_tensor)
                    features = features / features.norm(p=2, dim=-1, keepdim=True)

                all_features.append(features.cpu().to(torch.float32).numpy())

            if all_features:
                concatenated = np.vstack(all_features).astype(np.float32)
                return concatenated.tobytes()
            return b""


async def process_video_on_modal(
    video_id: str,
    items: list[LocalKeyframeItem],
    encoder_client: Any,
    output_dir: Path,
    config: RunConfig,
    cost_tracker: dict[str, Any],
    lock: Optional[asyncio.Lock] = None,
    zip_handle: Optional[zipfile.ZipFile] = None,
) -> bool:
    """Read local keyframes, stream them to Modal GPU worker, and save embeddings."""
    npy_path = output_dir / f"{video_id}.npy"
    pq_path = output_dir / f"{video_id}.parquet"
    if npy_path.exists() and pq_path.exists() and not config.overwrite:
        safe_print(f"[SKIP] {video_id} already has embeddings at {npy_path.name}")
        if lock:
            async with lock:
                cost_tracker["completed_videos"] = cost_tracker.get("completed_videos", 0) + 1
        else:
            cost_tracker["completed_videos"] = cost_tracker.get("completed_videos", 0) + 1
        return True

    safe_print(f"[PROCESSING] {video_id} ({len(items)} keyframes)...")
    t0 = time.perf_counter()

    valid_items = []
    image_bytes_list = []

    opened_zf = None
    zf_to_use = zip_handle
    if zf_to_use is None and items and items[0].zip_path:
        opened_zf = zipfile.ZipFile(items[0].zip_path, "r")
        zf_to_use = opened_zf

    try:
        for item in items:
            raw_bytes: Optional[bytes] = None
            if item.zip_member and zf_to_use:
                raw_bytes = zf_to_use.read(item.zip_member)
            elif item.image_path and item.image_path.exists():
                raw_bytes = item.image_path.read_bytes()
            else:
                logger.warning(f"Image not accessible for item: {item}")
                continue

            if raw_bytes and len(raw_bytes) <= MAX_IMAGE_BYTES:
                valid_items.append(item)
                image_bytes_list.append(raw_bytes)
    finally:
        if opened_zf:
            opened_zf.close()

    if not valid_items:
        logger.warning(f"No valid images for video {video_id}")
        return False

    embeddings_list = []
    chunk_size = config.submission_window
    for idx in range(0, len(image_bytes_list), chunk_size):
        chunk = image_bytes_list[idx : idx + chunk_size]
        for attempt in range(3):
            try:
                res_bytes = await encoder_client.encode_images.remote.aio(chunk, batch_size=GPU_BATCH_SIZE)
                if res_bytes:
                    arr = np.frombuffer(res_bytes, dtype=np.float32).reshape(-1, 1024)
                    embeddings_list.append(arr)
                break
            except Exception as e:
                if attempt == 2:
                    raise
                logger.warning(f"Retry {attempt + 1}/3 for {video_id} chunk: {e}")
                await asyncio.sleep(2 ** attempt)

    if embeddings_list:
        embeddings_np = np.vstack(embeddings_list)
    else:
        embeddings_np = np.zeros((0, 1024), dtype=np.float32)

    save_embedding_results(
        output_dir=output_dir,
        video_id=video_id,
        embeddings=embeddings_np,
        items=valid_items,
        model_name=config.model_name,
        pipeline_version=PIPELINE_VERSION,
        dtype=config.dtype,
    )

    elapsed = time.perf_counter() - t0
    step_cost = (elapsed / 3600.0) * GPU_RATE_USD_PER_HOUR

    if lock:
        async with lock:
            cost_tracker["total_cost_usd"] += step_cost
            cost_tracker["total_frames"] += len(valid_items)
            cost_tracker["completed_videos"] = cost_tracker.get("completed_videos", 0) + 1
            total_spent = cost_tracker["total_cost_usd"]
            done_count = cost_tracker["completed_videos"]
    else:
        cost_tracker["total_cost_usd"] += step_cost
        cost_tracker["total_frames"] += len(valid_items)
        cost_tracker["completed_videos"] = cost_tracker.get("completed_videos", 0) + 1
        total_spent = cost_tracker["total_cost_usd"]
        done_count = cost_tracker["completed_videos"]

    safe_print(
        f"[DONE] {video_id} ({done_count}) | {len(valid_items)} frames in {elapsed:.1f}s | "
        f"~${total_spent:.4f} spent"
    )
    return True


async def run_local_orchestrator(config: RunConfig) -> None:
    """Local orchestration loop submitting work to Modal."""
    grouped = discover_keyframes(config.input_dir)
    if config.video_ids:
        filter_set = set(config.video_ids)
        grouped = {k: v for k, v in grouped.items() if k in filter_set}

    total_videos = len(grouped)
    total_frames = sum(len(v) for v in grouped.values())

    safe_print("=== CLIPA-v2 ViT-H/14 Modal Extraction ===")
    safe_print(f"Input: {config.input_dir}")
    safe_print(f"Output: {config.output_dir}")
    safe_print(f"Found: {total_videos} videos with {total_frames} total keyframes")
    safe_print(f"Budget: ${config.budget_usd:.2f} (Model: {config.model_name})")

    if config.dry_run:
        safe_print("[DRY RUN] Finished scanning. Exiting without invoking Modal.")
        return

    if modal is None:
        raise RuntimeError("Modal SDK is not installed. Install via `pip install modal`.")

    config.output_dir.mkdir(parents=True, exist_ok=True)
    cost_tracker: dict[str, Any] = {"total_cost_usd": 0.0, "total_frames": 0, "completed_videos": 0}
    encoder = ModalClipEncoder()

    sem = asyncio.Semaphore(config.concurrency)
    lock = asyncio.Lock()

    # Pre-open zip if the input is a single zip file to share handle efficiently
    shared_zip = None
    if config.input_dir.is_file() and config.input_dir.suffix.lower() == ".zip":
        shared_zip = zipfile.ZipFile(config.input_dir, "r")

    try:
        async def worker(vid: str, items: list[LocalKeyframeItem]) -> None:
            async with sem:
                async with lock:
                    if cost_tracker["total_cost_usd"] >= config.budget_usd:
                        return
                await process_video_on_modal(
                    video_id=vid,
                    items=items,
                    encoder_client=encoder,
                    output_dir=config.output_dir,
                    config=config,
                    cost_tracker=cost_tracker,
                    lock=lock,
                    zip_handle=shared_zip,
                )

        tasks = [asyncio.create_task(worker(vid, items)) for vid, items in grouped.items()]
        await asyncio.gather(*tasks)
    finally:
        if shared_zip:
            shared_zip.close()

    safe_print(
        f"=== Summary ===\n"
        f"Completed videos: {cost_tracker['completed_videos']}/{total_videos}\n"
        f"Processed frames: {cost_tracker['total_frames']}\n"
        f"Estimated cost: ${cost_tracker['total_cost_usd']:.4f}\n"
        f"Outputs saved to: {config.output_dir}"
    )


def parse_args(args: Sequence[str] | None = None) -> RunConfig:
    parser = argparse.ArgumentParser(description="Run CLIPA-v2 ViT-H/14 visual embedding on Modal")
    parser.add_argument("--input-dir", type=str, required=True, help="Directory or .zip archive containing keyframes")
    parser.add_argument("--output-dir", type=str, required=True, help="Directory for output .npy and .parquet files")
    parser.add_argument("--video-ids", type=str, default=None, help="Comma-separated list of video IDs to process")
    parser.add_argument("--model-name", type=str, default=MODEL_NAME, help=f"OpenCLIP model identifier (default: {MODEL_NAME})")
    parser.add_argument("--budget-usd", type=float, default=30.0, help="Maximum budget threshold in USD")
    parser.add_argument("--submission-window", type=int, default=DEFAULT_SUBMISSION_WINDOW, help="In-flight async window")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="Number of concurrent videos to process")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing embeddings")
    parser.add_argument("--dry-run", action="store_true", help="Scan local keyframes without making remote Modal calls")
    parser.add_argument("--dtype", type=str, default="float32", choices=["float32", "float16"], help="Output vector dtype")

    parsed = parser.parse_args(args)
    vids = [v.strip() for v in parsed.video_ids.split(",")] if parsed.video_ids else None
    return RunConfig(
        input_dir=Path(parsed.input_dir),
        output_dir=Path(parsed.output_dir),
        model_name=parsed.model_name,
        budget_usd=parsed.budget_usd,
        submission_window=parsed.submission_window,
        concurrency=parsed.concurrency,
        overwrite=parsed.overwrite,
        dry_run=parsed.dry_run,
        dtype=parsed.dtype,
        video_ids=vids,
    )


if modal is not None and app is not None:
    @app.local_entrypoint()
    def main(
        input_dir: str,
        output_dir: str,
        video_ids: str = "",
        budget_usd: float = 30.0,
        submission_window: int = DEFAULT_SUBMISSION_WINDOW,
        concurrency: int = DEFAULT_CONCURRENCY,
        overwrite: bool = False,
        dry_run: bool = False,
        dtype: str = "float32",
    ) -> None:
        vids = [v.strip() for v in video_ids.split(",")] if video_ids else None
        cfg = RunConfig(
            input_dir=Path(input_dir),
            output_dir=Path(output_dir),
            budget_usd=budget_usd,
            submission_window=submission_window,
            concurrency=concurrency,
            overwrite=overwrite,
            dry_run=dry_run,
            dtype=dtype,
            video_ids=vids,
        )
        asyncio.run(run_local_orchestrator(cfg))


if __name__ == "__main__":
    cfg = parse_args()
    asyncio.run(run_local_orchestrator(cfg))

