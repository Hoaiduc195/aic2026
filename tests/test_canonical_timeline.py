from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import av
import numpy as np

from pipelines.preprocessing.keyframes.canonical_timeline import (
    build_canonical_timeline,
    load_canonical_timeline,
)


def _write_video(path: Path, frame_count: int = 4) -> None:
    with av.open(str(path), mode="w") as container:
        stream = container.add_stream("mpeg4", rate=Fraction(25, 1))
        stream.width = 48
        stream.height = 32
        stream.pix_fmt = "yuv420p"
        for index in range(frame_count):
            image = np.zeros((32, 48, 3), dtype=np.uint8)
            image[:, :, 0] = index * 20
            frame = av.VideoFrame.from_ndarray(image, format="rgb24")
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)


def test_metadata_only_timeline_is_sequential_and_exact(tmp_path: Path) -> None:
    video = tmp_path / "video.mp4"
    output = tmp_path / "timeline.parquet"
    _write_video(video)

    built = build_canonical_timeline(
        {"video_id": "v", "path": str(video), "fps_str": "25/1"},
        output,
    )
    loaded = load_canonical_timeline(output)

    assert len(built) == 4
    assert loaded["original_frame_id"].tolist() == [0, 1, 2, 3]
    assert loaded["decoded_frame_index"].tolist() == [0, 1, 2, 3]
    assert loaded["timestamp_ms"].tolist() == sorted(loaded["timestamp_ms"].tolist())
    assert set(loaded["timeline_backend"]) == {"pyav_sequential_metadata"}
