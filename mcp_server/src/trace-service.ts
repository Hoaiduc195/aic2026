import { randomUUID } from 'node:crypto';

import { rankFrameCandidates, lexicalEvidenceScore } from './ranking.js';
import { parseToolLimit } from './validation.js';
import type {
  BackendClientPort,
  BackendFrame,
  FrameEvidenceSummary,
  FrameRef,
  RankedFrame,
  TaskType,
  ToolCallTrace,
  TraceAnswerInput,
  TraceAnswerReport,
} from './types.js';

interface TraceServiceOptions {
  readonly maxResults: number;
  readonly maxNearbyFrames: number;
}

export interface CompareFramesInput {
  readonly reference: FrameRef;
  readonly candidates: readonly FrameRef[];
  readonly task: TaskType;
}

export interface CompareFramesReport {
  readonly reference: FrameRef;
  readonly candidates: RankedFrame[];
  readonly missingCandidates: FrameRef[];
  readonly warnings: string[];
}

export interface RankFramesInput {
  readonly query?: string;
  readonly reference?: FrameRef;
  readonly candidates: readonly FrameRef[];
  readonly task: TaskType;
}

export class TraceService {
  constructor(
    private readonly backend: BackendClientPort,
    private readonly options: TraceServiceOptions,
  ) {}

  async traceAnswer(input: TraceAnswerInput): Promise<TraceAnswerReport> {
    const traceId = randomUUID();
    const toolCalls: ToolCallTrace[] = [];
    const warnings: string[] = [];
    const limit = parseToolLimit(input.maxResults, this.options.maxResults);
    const response = input.candidateFrames?.length
      ? await this.recordCall(toolCalls, 'search_exact_frames', () => this.backend.searchExactFrames({ task: input.task, frames: input.candidateFrames!.slice(0, 100) }))
      : await this.recordCall(toolCalls, 'search_frames', () => this.backend.searchFrames({ query: input.query, task: input.task, topK: limit }));

    const candidates = response.results
      .map((result, index) => {
        const originalFrameId = result.original_frame_id ?? result.representative_frame?.original_frame_id;
        if (originalFrameId === null || originalFrameId === undefined) return null;
        return {
          videoId: result.video_id,
          originalFrameId,
          ...(result.representative_frame?.keyframe_no === undefined ? {} : { keyframeNo: result.representative_frame.keyframe_no }),
          score: result.score,
          sourceRank: index + 1,
        };
      })
      .filter((candidate): candidate is { videoId: string; originalFrameId: number; keyframeNo?: number; score: number; sourceRank: number } => candidate !== null);
    const ranked = rankFrameCandidates(candidates).slice(0, limit);
    const evidence: FrameEvidenceSummary[] = [];
    const supportingFrames: FrameRef[] = [];

    for (const candidate of ranked) {
      try {
        const frame = await this.recordCall(toolCalls, 'get_frame', () => this.backend.getFrame({ videoId: candidate.videoId, originalFrameId: candidate.originalFrameId }));
        evidence.push(summarizeFrame(frame));
        supportingFrames.push({ videoId: candidate.videoId, originalFrameId: candidate.originalFrameId, ...(frame.keyframe_no === null ? {} : { keyframeNo: frame.keyframe_no }) });
      } catch {
        warnings.push(`frame_unavailable:${candidate.videoId}:${candidate.originalFrameId}`);
      }
    }

    const relatedFrames: FrameRef[] = [];
    if (input.includeNearby && supportingFrames[0]) {
      try {
        const nearby = await this.recordCall(toolCalls, 'get_nearby_frames', () => this.backend.getNearbyFrames(
          supportingFrames[0].videoId,
          supportingFrames[0].originalFrameId!,
          parseToolLimit(undefined, this.options.maxNearbyFrames),
        ));
        for (const frame of nearby.frames) {
          if (frame.original_frame_id !== supportingFrames[0].originalFrameId) {
            relatedFrames.push({ videoId: frame.video_id, originalFrameId: frame.original_frame_id, keyframeNo: frame.keyframe_no });
          }
        }
      } catch {
        warnings.push(`nearby_frames_unavailable:${supportingFrames[0].videoId}:${supportingFrames[0].originalFrameId}`);
      }
    }

    const confidence = response.confidence?.score ?? 0;
    const verdict = supportingFrames.length === 0
      ? 'insufficient'
      : response.confidence?.action === 'abstain' || response.confidence?.level === 'unknown' || response.confidence?.level === 'low'
        ? 'uncertain'
        : 'supported';
    const missingEvidence = supportingFrames.length === 0
      ? ['No matching frames were returned by retrieval']
      : evidence.length < ranked.length
        ? ['One or more matching frames could not be loaded']
        : [];
    return {
      traceId,
      queryId: response.query_id ?? null,
      query: input.query,
      verdict,
      confidence,
      supportingFrames,
      relatedFrames,
      evidence,
      missingEvidence,
      warnings: [...response.warnings, ...warnings],
      toolCalls,
    };
  }

  async compareFrames(input: CompareFramesInput): Promise<CompareFramesReport> {
    const source = input.reference.originalFrameId === undefined
      ? await this.backend.getFrame(input.reference)
      : undefined;
    const sourceRef: FrameRef = source
      ? { videoId: source.video_id, originalFrameId: source.original_frame_id }
      : input.reference;
    const resolvedCandidates = await Promise.all(input.candidates.map(async (candidate) => {
      if (candidate.originalFrameId !== undefined) return candidate;
      const frame = await this.backend.getFrame(candidate);
      return { videoId: frame.video_id, originalFrameId: frame.original_frame_id, keyframeNo: frame.keyframe_no ?? undefined };
    }));
    const response = await this.backend.searchFrames({
      query: '',
      task: input.task,
      topK: Math.min(100, Math.max(resolvedCandidates.length, 1)),
      frameQuery: sourceRef,
    });
    const scores = new Map(response.results
      .filter((result) => result.original_frame_id !== null)
      .map((result, index) => [`${result.video_id}\u0000${result.original_frame_id}`, { score: result.score, sourceRank: index + 1 }]));
    const ranked = rankFrameCandidates(resolvedCandidates.flatMap((candidate) => {
      if (candidate.originalFrameId === undefined) return [];
      const match = scores.get(`${candidate.videoId}\u0000${candidate.originalFrameId}`);
      return match ? [{ videoId: candidate.videoId, originalFrameId: candidate.originalFrameId, ...(candidate.keyframeNo === undefined ? {} : { keyframeNo: candidate.keyframeNo }), score: match.score, sourceRank: match.sourceRank }] : [];
    }));
    const rankedKeys = new Set(ranked.map((candidate) => `${candidate.videoId}\u0000${candidate.originalFrameId}`));
    return {
      reference: sourceRef,
      candidates: ranked,
      missingCandidates: resolvedCandidates.filter((candidate) => candidate.originalFrameId !== undefined && !rankedKeys.has(`${candidate.videoId}\u0000${candidate.originalFrameId}`)),
      warnings: response.warnings,
    };
  }

  async rankFrames(input: RankFramesInput): Promise<{ readonly candidates: RankedFrame[]; readonly evidence: FrameEvidenceSummary[]; readonly warnings: string[] }> {
    if (input.reference) {
      const compared = await this.compareFrames({ reference: input.reference, candidates: input.candidates, task: input.task });
      return { candidates: compared.candidates, evidence: [], warnings: [...compared.warnings, ...(compared.missingCandidates.length ? ['Some candidates were not returned by visual retrieval'] : [])] };
    }
    const evidence: FrameEvidenceSummary[] = [];
    const candidates: RankedFrame[] = [];
    for (let index = 0; index < input.candidates.length; index += 1) {
      const frame = await this.backend.getFrame(input.candidates[index]);
      const summary = summarizeFrame(frame);
      evidence.push(summary);
      candidates.push({
        videoId: frame.video_id,
        originalFrameId: frame.original_frame_id,
        ...(frame.keyframe_no === null ? {} : { keyframeNo: frame.keyframe_no }),
        score: lexicalEvidenceScore(input.query ?? '', [...summary.captions, ...summary.ocr, ...summary.objects, ...summary.asr]),
        sourceRank: index + 1,
        rank: 0,
      });
    }
    return { candidates: rankFrameCandidates(candidates), evidence, warnings: [] };
  }

  private async recordCall<T>(calls: ToolCallTrace[], tool: string, operation: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await operation();
      calls.push({ tool, status: 'ok', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      calls.push({ tool, status: 'error', durationMs: Date.now() - started, error: error instanceof Error ? error.message : 'unknown error' });
      throw error;
    }
  }
}

function summarizeFrame(frame: BackendFrame): FrameEvidenceSummary {
  return {
    videoId: frame.video_id,
    originalFrameId: frame.original_frame_id,
    keyframeNo: frame.keyframe_no,
    timestampMs: frame.timestamp_ms,
    thumbnailUri: frame.thumbnail_uri,
    captions: frame.captions.map((item) => item.text),
    ocr: frame.ocr.map((item) => item.text),
    objects: frame.objects.map((item) => item.label),
    asr: frame.asr_spans.map((item) => item.text),
    evidenceIds: [
      ...frame.captions.map((item) => item.evidence_id),
      ...frame.ocr.map((item) => item.evidence_id),
      ...frame.objects.map((item) => item.evidence_id),
      ...frame.asr_spans.map((item) => item.evidence_id),
    ],
  };
}
