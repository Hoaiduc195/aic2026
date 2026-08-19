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
} from './contracts';
import { activeAsrSpans, studioFrameThumbnailUri } from './video-studio-model';

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
  const frames = response.results.flatMap((result) => {
    const frame = result.representative_frame;
    if (!frame) return [];

    const preferredPreview = frame.preview_uri ?? result.preview_uri;
    const thumbnailUri = isBrowserUri(preferredPreview)
      ? preferredPreview
      : `/api/v1/media/keyframes/${encodeURIComponent(result.video_id)}/by-frame/${frame.original_frame_id}`;

    return [{
      result_key: resultKey(result),
      video_id: result.video_id,
      ...(frame.keyframe_no === undefined ? {} : { keyframe_no: frame.keyframe_no }),
      original_frame_id: frame.original_frame_id,
      timestamp_ms: frame.timestamp_ms,
      thumbnail_uri: thumbnailUri,
      start_ms: result.start_ms,
      end_ms: result.end_ms,
      score: result.score,
      evidence: [...result.evidence],
      matched_modalities: [...result.matched_modalities],
    } satisfies FrameCandidate];
  });

  return { frames, skipped: response.results.length - frames.length };
}

/**
 * Replaces a retrieval result's sparse keyframe with the frame chosen in Studio.
 * The result identity and ranking metadata stay stable so reorder/export keep working.
 */
export function applyStudioFrameToCandidate(
  candidate: FrameCandidate,
  frame: StudioFrame,
  asrSpans: readonly StudioAsrSpan[],
): FrameCandidate {
  const asrEvidence = activeAsrSpans(asrSpans, frame.timestamp_ms).map((span) => ({
    evidence_id: span.evidence_id,
    type: 'asr' as const,
    snippet: span.text,
    producer: span.producer,
    start_ms: span.start_ms,
    end_ms: span.end_ms,
  }));

  return {
    ...candidate,
    keyframe_no: frame.keyframe_no ?? undefined,
    original_frame_id: frame.original_frame_id,
    timestamp_ms: frame.timestamp_ms,
    thumbnail_uri: studioFrameThumbnailUri(frame),
    evidence: [
      ...frame.captions.map((caption) => ({
        evidence_id: caption.evidence_id,
        type: 'caption' as const,
        snippet: caption.text,
        producer: caption.producer,
      })),
      ...frame.objects.map((object) => ({
        evidence_id: object.evidence_id,
        type: 'object' as const,
        snippet: object.label,
        producer: object.producer,
      })),
      ...asrEvidence,
    ],
  };
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

export function validateTrakeSequence(frames: readonly FrameCandidate[]): boolean {
  if (frames.length === 0) return false;
  const videoId = frames[0].video_id;
  return frames.every((frame, index) => (
    frame.video_id === videoId && (index === 0 || frames[index - 1].timestamp_ms < frame.timestamp_ms)
  ));
}

function isBrowserUri(value: string): boolean {
  return value.startsWith('/') || /^https?:\/\//i.test(value);
}

function isKeyframeOrdinal(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0;
}
