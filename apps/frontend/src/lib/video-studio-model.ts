import type { StudioAsrSpan, StudioFrame } from './contracts';

export function nearestStudioFrame(frames: readonly StudioFrame[], timestampMs: number): StudioFrame | null {
  return [...frames]
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms || left.original_frame_id - right.original_frame_id)
    .reduce<StudioFrame | null>((nearest, frame) => {
      if (!nearest) return frame;
      const distance = Math.abs(frame.timestamp_ms - timestampMs);
      const nearestDistance = Math.abs(nearest.timestamp_ms - timestampMs);
      return distance < nearestDistance ? frame : nearest;
    }, null);
}

export function activeAsrSpans(spans: readonly StudioAsrSpan[], timestampMs: number): StudioAsrSpan[] {
  return spans.filter((span) => span.start_ms <= timestampMs && timestampMs < span.end_ms);
}

export function keyframeLabel(frame: Pick<StudioFrame, 'keyframe_no' | 'original_frame_id'> & { is_exact_frame?: boolean }): string {
  return frame.is_exact_frame && (frame.keyframe_no === null || frame.keyframe_no === undefined)
    ? `Canonical frame ${frame.original_frame_id}`
    : `Keyframe ${frame.keyframe_no} · source frame ${frame.original_frame_id}`;
}

export function timelinePercent(timestampMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  const percentage = (timestampMs / durationMs) * 100;
  return Math.max(0, Math.min(100, percentage));
}

export function frameThumbnailUri(videoId: string, originalFrameId: number): string {
  return `/api/v1/media/keyframes/${encodeURIComponent(videoId)}/by-frame/${encodeURIComponent(String(originalFrameId))}`;
}

export function exactFrameThumbnailUri(videoId: string, originalFrameId: number): string {
  return `/api/v1/media/videos/${encodeURIComponent(videoId)}/frames/${encodeURIComponent(String(originalFrameId))}/thumbnail`;
}

export function studioFrameThumbnailUri(frame: Pick<StudioFrame, 'video_id' | 'original_frame_id' | 'is_exact_frame' | 'thumbnail_uri'>): string {
  return frame.thumbnail_uri
    ?? (frame.is_exact_frame ? exactFrameThumbnailUri(frame.video_id, frame.original_frame_id) : frameThumbnailUri(frame.video_id, frame.original_frame_id));
}
