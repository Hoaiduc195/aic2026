"""Map timestamped ASR chunks to video segments."""

from __future__ import annotations

from collections.abc import Iterable

from pipelines.feature_extraction.asr.models import AsrResult, Segment, TranscriptChunk


def _overlap_ms(left_start: int, left_end: int, right_start: int, right_end: int) -> int:
    return max(0, min(left_end, right_end) - max(left_start, right_start))


def map_transcripts_to_segments(
    video_id: str,
    transcripts: Iterable[TranscriptChunk],
    segments: Iterable[Segment],
    *,
    min_overlap_ms: int = 1,
) -> list[AsrResult]:
    """Return ASR rows for every transcript/segment temporal overlap.

    ASR is generated once per audio stream, then projected onto segment IDs.
    When one utterance crosses a segment boundary, the text is intentionally
    duplicated into each overlapping segment with clipped timestamps so segment
    search can retrieve either side of the boundary.
    """

    if not isinstance(min_overlap_ms, int) or min_overlap_ms < 1:
        raise ValueError("min_overlap_ms must be a positive integer")

    segment_list = sorted(segments, key=lambda segment: segment.segment_start_ms)
    mismatched_segments = [
        segment.segment_id for segment in segment_list if segment.video_id != video_id
    ]
    if mismatched_segments:
        raise ValueError(
            "segments contain a different video_id: "
            + ", ".join(mismatched_segments)
        )

    chunk_list = list(transcripts)
    results_by_chunk: list[list[AsrResult]] = [[] for _ in chunk_list]
    ordered_chunks = sorted(enumerate(chunk_list), key=lambda item: item[1].start_ms)
    active_segments: list[Segment] = []
    next_segment = 0

    for original_index, chunk in ordered_chunks:
        text = chunk.text.strip()
        if not text:
            continue

        while (
            next_segment < len(segment_list)
            and segment_list[next_segment].segment_start_ms < chunk.end_ms
        ):
            active_segments.append(segment_list[next_segment])
            next_segment += 1
        active_segments = [
            segment for segment in active_segments if segment.segment_end_ms > chunk.start_ms
        ]

        for segment in active_segments:
            overlap = _overlap_ms(
                chunk.start_ms,
                chunk.end_ms,
                segment.segment_start_ms,
                segment.segment_end_ms,
            )
            if overlap < min_overlap_ms:
                continue

            results_by_chunk[original_index].append(
                AsrResult(
                    video_id=video_id,
                    segment_id=segment.segment_id,
                    asr_start_ms=max(chunk.start_ms, segment.segment_start_ms),
                    asr_end_ms=min(chunk.end_ms, segment.segment_end_ms),
                    text=text,
                    confidence=chunk.confidence,
                )
            )

    return [result for chunk_results in results_by_chunk for result in chunk_results]
