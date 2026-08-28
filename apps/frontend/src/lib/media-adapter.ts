import type { VideoFrame } from './contracts';
import { MAX_NEARBY_FRAME_COUNT } from './nearby-frame-model';

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

export function selectFrameWindow(
  frames: readonly VideoFrame[],
  centerFrameId: number,
  requestedLimit: number,
  requestedFrameStep = 1,
): VideoFrame[] {
  if (frames.length === 0) return [];
  const limit = Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_NEARBY_FRAME_COUNT);
  const orderedFrames = [...frames].sort(compareFrameIds);
  const frameStep = Number.isSafeInteger(requestedFrameStep) && requestedFrameStep >= 1 ? requestedFrameStep : 1;
  let centerIndex = 0;
  let smallestDistance = Number.POSITIVE_INFINITY;
  orderedFrames.forEach((frame, index) => {
    const distance = Math.abs(frame.original_frame_id - centerFrameId);
    if (distance < smallestDistance) {
      centerIndex = index;
      smallestDistance = distance;
    }
  });

  const windowSize = Math.min(limit, orderedFrames.length);
  if (frameStep === 1) {
    const start = Math.min(Math.max(centerIndex - Math.floor(windowSize / 2), 0), orderedFrames.length - windowSize);
    return orderedFrames.slice(start, start + windowSize).map((frame) => ({ ...frame }));
  }

  const centerFrame = orderedFrames[centerIndex];
  const selectedCenterFrameId = centerFrame.original_frame_id;
  const selected = new Map<number, VideoFrame>([[centerFrame.original_frame_id, centerFrame]]);
  for (let offset = 1; offset <= orderedFrames.length && selected.size < windowSize; offset += 1) {
    for (const direction of [-1, 1] as const) {
      if (selected.size >= windowSize) break;
      const targetFrameId = selectedCenterFrameId + direction * offset * frameStep;
      const candidate = nearestFrameOnSide(orderedFrames, targetFrameId, selectedCenterFrameId, direction, selected);
      if (candidate) selected.set(candidate.original_frame_id, candidate);
    }
  }

  if (selected.size < windowSize) {
    const fallbackFrames = [...orderedFrames].sort((left, right) => (
      Math.abs(left.original_frame_id - centerFrameId) - Math.abs(right.original_frame_id - centerFrameId)
      || left.original_frame_id - right.original_frame_id
    ));
    for (const frame of fallbackFrames) {
      if (selected.size >= windowSize) break;
      if (!selected.has(frame.original_frame_id)) selected.set(frame.original_frame_id, frame);
    }
  }

  return [...selected.values()].sort(compareFrameIds).slice(0, windowSize).map((frame) => ({ ...frame }));
}

function compareFrameIds(left: VideoFrame, right: VideoFrame): number {
  return left.original_frame_id - right.original_frame_id;
}

function nearestFrameOnSide(
  frames: readonly VideoFrame[],
  targetFrameId: number,
  centerFrameId: number,
  direction: -1 | 1,
  selected: ReadonlyMap<number, VideoFrame>,
): VideoFrame | null {
  const candidates = frames.filter((frame) => (
    !selected.has(frame.original_frame_id)
      && (direction < 0 ? frame.original_frame_id < centerFrameId : frame.original_frame_id > centerFrameId)
  ));
  return candidates.sort((left, right) => (
    Math.abs(left.original_frame_id - targetFrameId) - Math.abs(right.original_frame_id - targetFrameId)
    || Math.abs(left.original_frame_id - centerFrameId) - Math.abs(right.original_frame_id - centerFrameId)
    || left.original_frame_id - right.original_frame_id
  ))[0] ?? null;
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
