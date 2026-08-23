import { randomUUID } from 'node:crypto';

import type {
  FrameEvidenceSummary,
  FrameRef,
  SearchLoopStatus,
  TaskType,
  ToolCallTrace,
} from './types.js';

export interface SearchSessionState {
  readonly sessionId: string;
  readonly task: TaskType;
  readonly originalQuery: string;
  readonly originalQuestion?: string;
  readonly requiredEvents: readonly string[];
  readonly improvedQuery?: string;
  readonly improvedQuestion?: string;
  readonly iterations: number;
  readonly toolCalls: readonly ToolCallTrace[];
  readonly attemptedFrames: readonly FrameRef[];
  readonly selectedFrames: readonly FrameRef[];
  readonly rejectedFrames: readonly FrameRef[];
  readonly evidence: readonly FrameEvidenceSummary[];
  readonly warnings: readonly string[];
  readonly status?: SearchLoopStatus;
  readonly stopReason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SearchSessionCreateInput {
  readonly sessionId?: string;
  readonly task: TaskType;
  readonly originalQuery: string;
  readonly originalQuestion?: string;
  readonly requiredEvents?: readonly string[];
}

export type SearchSessionPatch = Partial<Omit<SearchSessionState, 'sessionId' | 'createdAt'>>;

export interface SearchSessionStoreOptions {
  readonly maxSessions?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_SESSIONS = 20;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export class SearchSessionStore {
  private readonly sessions = new Map<string, SearchSessionState>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: SearchSessionStoreOptions = {}) {
    this.maxSessions = boundedPositive(options.maxSessions ?? DEFAULT_MAX_SESSIONS, 'maxSessions');
    this.ttlMs = boundedPositive(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
    this.now = options.now ?? Date.now;
  }

  create(input: SearchSessionCreateInput): SearchSessionState {
    this.purgeExpired();
    const timestamp = this.now();
    const sessionId = input.sessionId?.trim() || randomUUID();
    const state: SearchSessionState = {
      sessionId,
      task: input.task,
      originalQuery: input.originalQuery,
      ...(input.originalQuestion === undefined ? {} : { originalQuestion: input.originalQuestion }),
      requiredEvents: [...(input.requiredEvents ?? [])],
      iterations: 0,
      toolCalls: [],
      attemptedFrames: [],
      selectedFrames: [],
      rejectedFrames: [],
      evidence: [],
      warnings: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, state);
    this.evictOverflow();
    return cloneState(state);
  }

  get(sessionId: string): SearchSessionState | null {
    this.purgeExpired();
    const state = this.sessions.get(sessionId);
    return state ? cloneState(state) : null;
  }

  update(sessionId: string, patch: SearchSessionPatch): SearchSessionState {
    this.purgeExpired();
    const current = this.sessions.get(sessionId);
    if (!current) throw new Error('search session was not found or expired');
    const next: SearchSessionState = {
      ...current,
      ...patch,
      sessionId: current.sessionId,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      ...(patch.requiredEvents ? { requiredEvents: [...patch.requiredEvents] } : {}),
      ...(patch.toolCalls ? { toolCalls: [...patch.toolCalls] } : {}),
      ...(patch.attemptedFrames ? { attemptedFrames: [...patch.attemptedFrames] } : {}),
      ...(patch.selectedFrames ? { selectedFrames: [...patch.selectedFrames] } : {}),
      ...(patch.rejectedFrames ? { rejectedFrames: [...patch.rejectedFrames] } : {}),
      ...(patch.evidence ? { evidence: patch.evidence.map(sanitizeEvidence) } : {}),
      ...(patch.warnings ? { warnings: [...patch.warnings] } : {}),
    };
    this.sessions.set(sessionId, next);
    return cloneState(next);
  }

  size(): number {
    this.purgeExpired();
    return this.sessions.size;
  }

  private purgeExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [sessionId, state] of this.sessions) {
      if (state.updatedAt <= cutoff) this.sessions.delete(sessionId);
    }
  }

  private evictOverflow(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) return;
      this.sessions.delete(oldest.sessionId);
    }
  }
}

function boundedPositive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function cloneState(state: SearchSessionState): SearchSessionState {
  return {
    ...state,
    requiredEvents: [...state.requiredEvents],
    toolCalls: [...state.toolCalls],
    attemptedFrames: state.attemptedFrames.map((frame) => ({ ...frame })),
    selectedFrames: state.selectedFrames.map((frame) => ({ ...frame })),
    rejectedFrames: state.rejectedFrames.map((frame) => ({ ...frame })),
    evidence: state.evidence.map(sanitizeEvidence),
    warnings: [...state.warnings],
  };
}

function sanitizeEvidence(item: FrameEvidenceSummary): FrameEvidenceSummary {
  return {
    ...item,
    // Signed preview URLs are response-scoped secrets; sessions retain only evidence text and IDs.
    thumbnailUri: null,
    captions: [...item.captions],
    ocr: [...item.ocr],
    objects: [...item.objects],
    asr: [...item.asr],
    evidenceIds: [...item.evidenceIds],
  };
}
