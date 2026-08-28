import type {
  FrameCandidate,
  QaAnswer,
  QualificationAnswer,
  QualificationSubmission,
  QualificationTask,
  SearchResult,
  SearchEvidence,
  SearchResponse,
  StudioAsrSpan,
  StudioFrame,
  TextualKisAnswer,
  TrakeAnswer,
  VideoFrame,
} from './contracts';
import { activeAsrSpans, exactFrameThumbnailUri, frameThumbnailUri, studioFrameThumbnailUri } from './video-studio-model';

export interface NormalizedFrames {
  frames: FrameCandidate[];
  skipped: number;
}

export interface EvidenceGroups {
  ocr: SearchEvidence[];
  asr: SearchEvidence[];
  caption: SearchEvidence[];
  object: SearchEvidence[];
  visual: SearchEvidence[];
  other: SearchEvidence[];
}

const HIDDEN_USER_MODALITIES = new Set(['embedding', 'visual']);

/** Embedding/visual retrieval signals are not user-facing evidence labels. */
export function displayMatchedModalities(modalities: readonly string[]): string {
  return modalities
    .filter((modality) => !HIDDEN_USER_MODALITIES.has(modality))
    .join(' · ');
}

export function parseFrame(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function buildAnswer(
  task: QualificationTask,
  result: SearchResult,
  frameIndex: string,
  answerText: string,
  trakeFrames: readonly string[],
): QualificationAnswer | null {
  if (task === 'textual_kis') {
    const frame = parseFrame(frameIndex);
    return frame === null ? null : ({ video_id: result.video_id, frame_id: frame } satisfies TextualKisAnswer);
  }

  if (task === 'qa') {
    const frame = parseFrame(frameIndex);
    return frame === null || !answerText.trim()
      ? null
      : ({ video_id: result.video_id, frame_id: frame, answer: answerText.trim() } satisfies QaAnswer);
  }

  const frames = trakeFrames.map(parseFrame);
  return frames.length === 0 || frames.some((frame) => frame === null)
    ? null
    : ({ video_id: result.video_id, frame_ids: frames as number[] } satisfies TrakeAnswer);
}

export function buildSubmission(
  task: QualificationTask,
  queryId: string,
  answers: readonly QualificationAnswer[],
): QualificationSubmission | null {
  if (answers.length === 0 || answers.length > 100) {
    return null;
  }

  return { query_id: queryId, task, answers: [...answers] };
}

export function reorderFrames(
  frames: readonly FrameCandidate[],
  from: number,
  to: number,
): FrameCandidate[] {
  if (
    from < 0
    || from >= frames.length
    || to < 0
    || to >= frames.length
    || from === to
  ) {
    return [...frames];
  }

  const next = [...frames];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export type FrameBoundary = 'top' | 'bottom';

export function moveFrameToBoundary(
  frames: readonly FrameCandidate[],
  from: number,
  boundary: FrameBoundary,
): FrameCandidate[] {
  const to = boundary === 'top' ? 0 : frames.length - 1;
  return reorderFrames(frames, from, to);
}

export function buildRankedTextualSubmission(
  queryId: string,
  frames: readonly FrameCandidate[],
): QualificationSubmission | null {
  const answers: TextualKisAnswer[] = frames
    .slice(0, 100)
    .map((frame) => ({ video_id: frame.video_id, frame_id: frame.original_frame_id }));
  return buildSubmission('textual_kis', queryId, answers);
}

export function fillTextualKisAnswers(
  existing: readonly TextualKisAnswer[],
  frames: readonly FrameCandidate[],
  limit = 100,
): TextualKisAnswer[] {
  const maxItems = Math.max(0, Math.min(100, Math.floor(limit)));
  const current = existing.map((answer) => ({ ...answer }));
  const known = new Set(current.map((answer) => `${answer.video_id}\u0000${answer.frame_id}`));
  const additions = frames.flatMap((frame) => {
    const key = `${frame.video_id}\u0000${frame.original_frame_id}`;
    if (known.has(key)) return [];
    known.add(key);
    return [{ video_id: frame.video_id, frame_id: frame.original_frame_id }];
  });
  return [...current, ...additions].slice(0, maxItems);
}

export function resultKey(result: SearchResult): string {
  return `${result.video_id}\u0000${result.original_frame_id ?? `${result.start_ms}:${result.end_ms}`}`;
}

export function frameCandidateLabel(
  frame: Pick<FrameCandidate, 'video_id' | 'keyframe_no' | 'original_frame_id'>,
): string {
  return isKeyframeOrdinal(frame.keyframe_no)
    ? `keyframe ${frame.video_id} · ${frame.keyframe_no} · source frame ${frame.original_frame_id}`
    : `frame ${frame.video_id} · ${frame.original_frame_id}`;
}

export function frameCandidateDisplayLabel(
  frame: Pick<FrameCandidate, 'keyframe_no' | 'original_frame_id'>,
): string {
  return isKeyframeOrdinal(frame.keyframe_no)
    ? `Keyframe ${frame.keyframe_no} · Source frame ${frame.original_frame_id}`
    : `Frame ${frame.original_frame_id}`;
}

export function formatMs(value: number): string {
  return `${(value / 1000).toFixed(2)}s`;
}

export function toFrameCandidates(response: SearchResponse): NormalizedFrames {
  const exactFrameQuery = response.query_mode === 'exact_frames';
  const frames = response.results.flatMap((result) => {
    const frame = result.representative_frame;
    if (!frame) return [];

    return [{
      result_key: resultKey(result),
      video_id: result.video_id,
      ...(frame.keyframe_no === undefined ? {} : { keyframe_no: frame.keyframe_no }),
      original_frame_id: frame.original_frame_id,
      timestamp_ms: frame.timestamp_ms,
      thumbnail_uri: exactFrameQuery
        ? exactFrameThumbnailUri(result.video_id, frame.original_frame_id)
        : frameThumbnailUri(result.video_id, frame.original_frame_id),
      start_ms: result.start_ms,
      end_ms: result.end_ms,
      score: result.score,
      evidence: [...result.evidence],
      matched_modalities: [...result.matched_modalities],
      ...(exactFrameQuery ? {
        is_exact_frame: true,
        annotation_source_frame_id: null,
      } : {}),
    } satisfies FrameCandidate];
  });

  return { frames, skipped: response.results.length - frames.length };
}

export function nearbyFrameToCandidate(frame: VideoFrame): FrameCandidate {
  const keyframeNo = frame.keyframe_no ?? undefined;
  return {
    result_key: frameIdentity(frame),
    video_id: frame.video_id,
    ...(keyframeNo === undefined ? {} : { keyframe_no: keyframeNo }),
    original_frame_id: frame.original_frame_id,
    timestamp_ms: frame.timestamp_ms,
    thumbnail_uri: frame.thumbnail_uri,
    start_ms: frame.timestamp_ms,
    end_ms: frame.timestamp_ms,
    score: 0,
    evidence: [...(frame.evidence ?? [])],
    matched_modalities: ['context'],
  };
}

export function mergeNearbyFrameCandidates(
  current: readonly FrameCandidate[],
  nearby: readonly VideoFrame[],
  centerFrame?: Pick<FrameCandidate, 'video_id' | 'original_frame_id'>,
): FrameCandidate[] {
  const existingKeys = new Set(current.map(frameIdentity));
  const known = new Set(existingKeys);
  const nearbyCandidates = nearby.map(nearbyFrameToCandidate);
  const additions = nearbyCandidates.filter((candidate) => {
    if (known.has(candidate.result_key)) return false;
    known.add(candidate.result_key);
    return true;
  });
  if (additions.length === 0) return [...current];

  const centerKey = centerFrame
    ? frameIdentity(centerFrame)
    : nearbyCandidates.find((candidate) => existingKeys.has(candidate.result_key))?.result_key;
  const centerIndex = centerKey
    ? current.findIndex((frame) => frameIdentity(frame) === centerKey)
    : -1;
  const insertionIndex = centerIndex >= 0 ? centerIndex + 1 : current.length;
  return [
    ...current.slice(0, insertionIndex),
    ...additions,
    ...current.slice(insertionIndex),
  ];
}

function frameIdentity(frame: Pick<FrameCandidate, 'video_id' | 'original_frame_id'>): string {
  return `${frame.video_id}\u0000${frame.original_frame_id}`;
}

export function normalizeFrameCandidate(frame: FrameCandidate): FrameCandidate {
  return {
    ...frame,
    thumbnail_uri: frame.is_exact_frame
      ? exactFrameThumbnailUri(frame.video_id, frame.original_frame_id)
      : frameThumbnailUri(frame.video_id, frame.original_frame_id),
  };
}

/**
 * Replaces a retrieval result's sparse keyframe with the frame chosen in Studio.
 * The result identity and ranking metadata stay stable so reorder/export keep working.
 */
export function applyStudioFrameToCandidate(
  candidate: FrameCandidate,
  frame: StudioFrame,
  asrSpans: readonly StudioAsrSpan[] = [],
): FrameCandidate {
  const asrEvidence = activeAsrSpans(asrSpans, frame.timestamp_ms).map((span) => ({
    evidence_id: span.evidence_id,
    type: 'asr' as const,
    snippet: span.text,
    producer: span.producer,
    start_ms: span.start_ms,
    end_ms: span.end_ms,
  }));

  const frameOcr = frame.ocr ? frame.ocr.map((ocr) => ({
    evidence_id: ocr.evidence_id,
    type: 'ocr' as const,
    snippet: ocr.text,
    producer: ocr.producer,
  })) : undefined;

  const ocrEvidence = frameOcr ?? candidate.evidence.filter((e) => e.type === 'ocr');
  const captionEvidence = frame.captions.length > 0
    ? frame.captions.map((caption) => ({
        evidence_id: caption.evidence_id,
        type: 'caption' as const,
        snippet: caption.text,
        producer: caption.producer,
      }))
    : candidate.evidence.filter((e) => e.type === 'caption');

  const objectEvidence = frame.objects.length > 0
    ? frame.objects.map((object) => ({
        evidence_id: object.evidence_id,
        type: 'object' as const,
        snippet: object.label,
        producer: object.producer,
      }))
    : candidate.evidence.filter((e) => e.type === 'object');

  const finalAsrEvidence = asrEvidence.length > 0
    ? asrEvidence
    : candidate.evidence.filter((e) => e.type === 'asr' || e.type === 'audio');

  const merged = [
    ...ocrEvidence,
    ...captionEvidence,
    ...objectEvidence,
    ...finalAsrEvidence,
  ];

  const uniqueMap = new Map<string, SearchEvidence>();
  for (const item of merged) {
    const key = `${item.type}:${item.snippet?.trim() ?? item.evidence_id}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, item);
    }
  }

  return {
    ...candidate,
    keyframe_no: frame.keyframe_no ?? undefined,
    original_frame_id: frame.original_frame_id,
    timestamp_ms: frame.timestamp_ms,
    thumbnail_uri: studioFrameThumbnailUri(frame),
    ...(frame.is_exact_frame ? {
      is_exact_frame: true,
      annotation_source_frame_id: frame.annotation_source_frame_id ?? null,
    } : {
      is_exact_frame: undefined,
      annotation_source_frame_id: undefined,
    }),
    evidence: Array.from(uniqueMap.values()),
  };
}

export function applyCanonicalFrameToCandidate(
  candidate: FrameCandidate,
  frame: import('./contracts').CanonicalFrameResponse,
): FrameCandidate {
  return applyStudioFrameToCandidate(candidate, frame, frame.asr_spans ?? []);
}

export function groupEvidence(evidence: readonly SearchEvidence[], frameTimestampMs?: number): EvidenceGroups {
  return evidence.reduce<EvidenceGroups>((groups, item) => {
    const isAsr = item.type === 'asr' || item.type === 'audio';
    if (
      isAsr
      && frameTimestampMs !== undefined
      && item.start_ms !== undefined
      && item.end_ms !== undefined
      && (frameTimestampMs < item.start_ms || frameTimestampMs > item.end_ms)
    ) {
      return groups;
    }

    const key = item.type === 'ocr'
      ? 'ocr'
      : isAsr
        ? 'asr'
        : item.type === 'caption'
          ? 'caption'
          : item.type === 'object'
            ? 'object'
            : ['frame', 'track', 'temporal'].includes(item.type)
            ? 'visual'
            : 'other';
    return { ...groups, [key]: [...groups[key], item] };
  }, { ocr: [], asr: [], caption: [], object: [], visual: [], other: [] });
}

export const TRAKE_FRAME_COUNT = 4;

export function validateTrakeSequence(frames: readonly FrameCandidate[]): boolean {
  if (frames.length !== TRAKE_FRAME_COUNT) return false;
  const videoId = frames[0].video_id;
  return frames.every((frame, index) => (
    frame.video_id === videoId
      && (index === 0 || frames[index - 1].timestamp_ms < frame.timestamp_ms)
      && (index === 0 || frames[index - 1].original_frame_id < frame.original_frame_id)
  ));
}

export function emptyTrakeFrameSlots(): Array<FrameCandidate | null> {
  return Array.from({ length: TRAKE_FRAME_COUNT }, () => null);
}

export function normalizeTrakeFrameSlots(
  frames: readonly (FrameCandidate | null)[],
): Array<FrameCandidate | null> {
  return Array.from({ length: TRAKE_FRAME_COUNT }, (_, index) => frames[index] ?? null);
}

export function sortTrakeFrames(frames: readonly FrameCandidate[]): FrameCandidate[] {
  return [...frames].sort((left, right) => (
    left.timestamp_ms - right.timestamp_ms || left.original_frame_id - right.original_frame_id
  ));
}

/**
 * Automatically selects 4 chronological frames for TRAKE from available video frames or studio frames.
 */
export function autoSelectNearbyTrakeFrames(
  anchor: FrameCandidate,
  availableFrames: readonly (StudioFrame | FrameCandidate)[],
  asrSpans: readonly StudioAsrSpan[] = [],
): FrameCandidate[] {
  const converted: FrameCandidate[] = availableFrames
    .filter((frame) => frame.video_id === anchor.video_id)
    .map((frame) => ('result_key' in frame ? frame : applyStudioFrameToCandidate(anchor, frame, asrSpans)));

  const uniqueMap = new Map<number, FrameCandidate>();
  for (const frame of converted) {
    if (!uniqueMap.has(frame.original_frame_id)) {
      uniqueMap.set(frame.original_frame_id, frame);
    }
  }
  if (!uniqueMap.has(anchor.original_frame_id)) {
    uniqueMap.set(anchor.original_frame_id, anchor);
  }

  const sorted = sortTrakeFrames(Array.from(uniqueMap.values()));

  if (sorted.length >= TRAKE_FRAME_COUNT) {
    const anchorIdx = sorted.findIndex((frame) => frame.original_frame_id === anchor.original_frame_id);
    const startIdx = Math.max(0, Math.min(anchorIdx >= 0 ? anchorIdx : 0, sorted.length - TRAKE_FRAME_COUNT));
    const selected = sorted.slice(startIdx, startIdx + TRAKE_FRAME_COUNT);
    if (validateTrakeSequence(selected)) {
      return selected;
    }
  }

  return [];
}

/**
 * Automatically generates a batch of TRAKE answers (up to maxCount) from ranked retrieval frames.
 */
export function autoBuildTrakeAnswers(
  rankedFrames: readonly FrameCandidate[],
  maxCount = 100,
): TrakeAnswer[] {
  const byVideo = new Map<string, FrameCandidate[]>();
  for (const frame of rankedFrames) {
    const list = byVideo.get(frame.video_id) ?? [];
    list.push(frame);
    byVideo.set(frame.video_id, list);
  }

  const answers: TrakeAnswer[] = [];
  for (const [videoId, frames] of byVideo.entries()) {
    if (answers.length >= maxCount) break;
    const sorted = sortTrakeFrames(frames);
    const unique = sorted.filter((frame, idx, arr) => (
      idx === 0 || frame.original_frame_id !== arr[idx - 1].original_frame_id
    ));

    let frameIds: number[];
    if (unique.length >= TRAKE_FRAME_COUNT) {
      frameIds = unique.slice(0, TRAKE_FRAME_COUNT).map((frame) => frame.original_frame_id);
    } else {
      frameIds = [];
    }

    if (frameIds.length === TRAKE_FRAME_COUNT) {
      answers.push({
        video_id: videoId,
        frame_ids: frameIds,
      });
    }
  }

  return answers;
}

function isKeyframeOrdinal(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}

