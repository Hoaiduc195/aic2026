import type { VideoFrame } from './contracts';

export interface ByteRange {
  start: number;
  end: number;
}

export function isSafeVideoId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export function parseFrameMapCsv(csv: string, videoId: string): VideoFrame[] {
  if (!isSafeVideoId(videoId)) throw new Error('video_id không hợp lệ');
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0]?.trim() !== 'n,pts_time,fps,frame_idx') {
    throw new Error('frame map không đúng định dạng');
  }

  return lines.slice(1).filter(Boolean).map((line, index) => {
    const [rawNumber, rawPtsTime, , rawFrameIndex] = line.split(',');
    const keyframeNo = Number(rawNumber);
    const ptsTime = Number(rawPtsTime);
    const originalFrameId = Number(rawFrameIndex);
    if (!Number.isSafeInteger(keyframeNo) || keyframeNo < 1 || !Number.isFinite(ptsTime) || ptsTime < 0 || !Number.isSafeInteger(originalFrameId) || originalFrameId < 0) {
      throw new Error(`frame map có dữ liệu không hợp lệ tại dòng ${index + 2}`);
    }

    return {
      video_id: videoId,
      keyframe_no: keyframeNo,
      original_frame_id: originalFrameId,
      timestamp_ms: Math.round(ptsTime * 1000),
      thumbnail_uri: `/api/v1/media/keyframes/${encodeURIComponent(videoId)}/by-frame/${originalFrameId}`,
    };
  });
}

export function selectFrameWindow(frames: readonly VideoFrame[], centerFrameId: number, requestedLimit: number): VideoFrame[] {
  if (frames.length === 0) return [];
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), 50);
  let centerIndex = 0;
  let smallestDistance = Number.POSITIVE_INFINITY;
  frames.forEach((frame, index) => {
    const distance = Math.abs(frame.original_frame_id - centerFrameId);
    if (distance < smallestDistance) {
      centerIndex = index;
      smallestDistance = distance;
    }
  });

  const windowSize = Math.min(limit, frames.length);
  const start = Math.min(Math.max(centerIndex - Math.floor(windowSize / 2), 0), frames.length - windowSize);
  return frames.slice(start, start + windowSize).map((frame) => ({ ...frame }));
}

export function parseByteRange(header: string | null, size: number): ByteRange | null {
  if (!header || !Number.isSafeInteger(size) || size <= 0) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}
