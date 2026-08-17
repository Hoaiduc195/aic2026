import type {
  FrameCandidate,
  QaAnswer,
  QualificationAnswer,
  QualificationSubmission,
  QualificationTask,
  SearchResult,
  SearchEvidence,
  SearchResponse,
  TextualKisAnswer,
  TrakeAnswer,
} from './contracts';

export interface NormalizedFrames {
  frames: FrameCandidate[];
  skipped: number;
}

export interface EvidenceGroups {
  ocr: SearchEvidence[];
  asr: SearchEvidence[];
  caption: SearchEvidence[];
  visual: SearchEvidence[];
  other: SearchEvidence[];
}

const HIDDEN_USER_MODALITIES = new Set(['embedding']);

/** Embedding is a retrieval signal, not a user-facing evidence label. */
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

export function resultKey(result: SearchResult): string {
  return `${result.video_id}\u0000${result.original_frame_id ?? `${result.start_ms}:${result.end_ms}`}`;
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

export function groupEvidence(evidence: readonly SearchEvidence[]): EvidenceGroups {
  return evidence.reduce<EvidenceGroups>((groups, item) => {
    const key = item.type === 'ocr'
      ? 'ocr'
      : item.type === 'asr' || item.type === 'audio'
        ? 'asr'
        : item.type === 'caption'
          ? 'caption'
          : ['frame', 'object', 'track', 'temporal'].includes(item.type)
            ? 'visual'
            : 'other';
    return { ...groups, [key]: [...groups[key], item] };
  }, { ocr: [], asr: [], caption: [], visual: [], other: [] });
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
