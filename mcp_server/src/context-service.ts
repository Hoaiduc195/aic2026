import { assessTrake, summarizeFrame } from './search-loop.js';
import type {
  BackendClientPort,
  BackendFrame,
  BackendVideoFrames,
  BackendVideoPlayback,
  BackendStudio,
  FrameImage,
  FrameRef,
  FrameEvidenceSummary,
  TrakeCoverageReport,
} from './types.js';

const MAX_BATCH_FRAMES = 100;
const MAX_BATCH_IMAGES = 20;

export interface FrameContextItem {
  readonly ref: FrameRef;
  readonly frame?: BackendFrame;
  readonly image?: FrameImage;
  readonly error?: string;
}

export interface FrameContextBatch {
  readonly frames: readonly FrameContextItem[];
  readonly warnings: readonly string[];
}

export interface VideoContextInput {
  readonly videoId: string;
  readonly centerFrameId?: number;
  readonly nearbyLimit: number;
  readonly includeStudio: boolean;
}

export interface VideoContext {
  readonly video: BackendVideoPlayback;
  readonly studio?: BackendStudio;
  readonly nearby?: BackendVideoFrames;
  readonly warnings: readonly string[];
}

export interface TrakeSequenceCheck {
  readonly coverage: TrakeCoverageReport;
  readonly evidence: readonly FrameEvidenceSummary[];
  readonly frames: readonly FrameRef[];
  readonly warnings: readonly string[];
}

export async function getFrameContextBatch(
  backend: BackendClientPort,
  refs: readonly FrameRef[],
  includeImages: boolean,
): Promise<FrameContextBatch> {
  if (refs.length < 1 || refs.length > MAX_BATCH_FRAMES) throw new Error('frames must contain 1-100 items');
  const warnings: string[] = [];
  if (includeImages && refs.length > MAX_BATCH_IMAGES) warnings.push(`images_limited_to_first_${MAX_BATCH_IMAGES}_frames`);
  const items = await Promise.all(refs.map(async (ref, index): Promise<FrameContextItem> => {
    try {
      const frame = await backend.getFrame(ref);
      if (!includeImages || index >= MAX_BATCH_IMAGES) return { ref: { ...ref }, frame };
      try {
        const image = await backend.getFrameImage({ videoId: frame.video_id, originalFrameId: frame.original_frame_id });
        return { ref: { ...ref }, frame, image };
      } catch {
        return { ref: { ...ref }, frame, error: 'frame image unavailable' };
      }
    } catch {
      return { ref: { ...ref }, error: 'frame context unavailable' };
    }
  }));
  if (items.some((item) => item.error)) warnings.push('one_or_more_frame_contexts_unavailable');
  return { frames: items, warnings };
}

export async function getVideoContext(backend: BackendClientPort, input: VideoContextInput): Promise<VideoContext> {
  const video = await backend.getVideo(input.videoId);
  const warnings: string[] = [];
  const [studio, nearby] = await Promise.all([
    input.includeStudio
      ? backend.getStudio(input.videoId).catch(() => { warnings.push('studio_unavailable'); return undefined; })
      : Promise.resolve(undefined),
    input.centerFrameId === undefined
      ? Promise.resolve(undefined)
      : backend.getNearbyFrames(input.videoId, input.centerFrameId, input.nearbyLimit).catch(() => { warnings.push('nearby_frames_unavailable'); return undefined; }),
  ]);
  return { video, ...(studio ? { studio } : {}), ...(nearby ? { nearby } : {}), warnings };
}

export async function checkTrakeSequence(
  backend: BackendClientPort,
  events: readonly string[],
  refs: readonly FrameRef[],
): Promise<TrakeSequenceCheck> {
  if (events.length !== 4) throw new Error('TRAKE requires exactly four events');
  if (refs.length < 1 || refs.length > 20) throw new Error('frames must contain 1-20 items');
  const warnings: string[] = [];
  const loaded = await Promise.all(refs.map(async (ref) => {
    try {
      return await backend.getFrame(ref);
    } catch {
      warnings.push(`frame_unavailable:${ref.videoId}`);
      return undefined;
    }
  }));
  const frames = loaded.filter((frame): frame is BackendFrame => frame !== undefined);
  const evidence = frames.map(summarizeFrame);
  return {
    coverage: assessTrake(events, evidence),
    evidence,
    frames: frames.map((frame) => ({ videoId: frame.video_id, originalFrameId: frame.original_frame_id, ...(frame.keyframe_no === null ? {} : { keyframeNo: frame.keyframe_no }) })),
    warnings,
  };
}
