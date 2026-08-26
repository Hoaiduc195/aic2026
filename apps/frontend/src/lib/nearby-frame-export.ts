import type { FrameCandidate, VideoFrame } from './contracts';

type NearbyFrameCenter = Pick<FrameCandidate, 'video_id' | 'original_frame_id' | 'timestamp_ms'>;

const CSV_HEADER = ['video_id', 'original_frame_id', 'keyframe_no', 'timestamp_ms', 'is_center'];

export function buildNearbyFrameCsv(
  center: NearbyFrameCenter,
  frames: readonly VideoFrame[],
): string {
  const frameAtCenter = frames.find((frame) => (
    frame.video_id === center.video_id && frame.original_frame_id === center.original_frame_id
  ));
  const centerRow: VideoFrame = frameAtCenter ?? {
    video_id: center.video_id,
    original_frame_id: center.original_frame_id,
    timestamp_ms: center.timestamp_ms,
    thumbnail_uri: '',
  };
  const seen = new Set<string>();
  const rows = [centerRow, ...frames].flatMap((frame) => {
    if (frame.video_id !== center.video_id) return [];
    const key = `${frame.video_id}\u0000${frame.original_frame_id}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [frame];
  });

  return [
    CSV_HEADER.map(csvCell).join(','),
    ...rows.map((frame) => [
      frame.video_id,
      frame.original_frame_id,
      frame.keyframe_no ?? '',
      frame.timestamp_ms,
      frame.video_id === center.video_id && frame.original_frame_id === center.original_frame_id,
    ].map(csvCell).join(',')),
  ].join('\r\n') + '\r\n';
}

function csvCell(value: string | number | boolean): string {
  const raw = String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
