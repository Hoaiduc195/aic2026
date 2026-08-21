'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  FrameCandidate,
  CanonicalFrameResponse,
  ExactFrameSearchRequest,
  QaAnswer,
  QualificationAnswer,
  QualificationEventInput,
  QualificationTask,
  QueryImprovementRequest,
  QueryImprovementResponse,
  SearchRequest,
  SearchResponse,
  SelectionRevision,
  SubmissionPreview,
  StudioFrame,
  TextualKisAnswer,
  TrakeAnswer,
  VqaAnswerRequest,
  VqaAnswerSuggestion,
  VideoStudioResponse,
} from '../lib/contracts';
import {
  DEFAULT_LLM_SETTINGS,
  buildVqaLlmConfig,
  loadLlmSettings,
  saveLlmSettings,
  validateLlmSettings,
  type LlmSettings,
} from '../lib/llm-settings';
import {
  loadQueryImproverSettings,
  saveQueryImproverSettings,
  type QueryImproverSettings,
} from '../lib/query-improver-settings';
import {
  DEFAULT_VLM_SETTINGS,
  buildVqaVlmConfig,
  loadVlmSettings,
  saveVlmSettings,
  validateVlmSettings,
  type VlmSettings,
} from '../lib/vlm-settings';
import {
  buildSearchEmbeddingConfig,
  DEFAULT_EMBEDDING_SETTINGS,
  loadEmbeddingSettings,
  saveEmbeddingSettings,
  validateEmbeddingSettings,
  type EmbeddingSettings,
} from '../lib/embedding-settings';
import {
  buildSearchRetrievalConfig,
  DEFAULT_RETRIEVAL_SETTINGS,
  loadRetrievalSettings,
  saveRetrievalSettings,
  validateRetrievalSettings,
  type RetrievalSettings,
} from '../lib/retrieval-settings';
import {
  buildSearchRrfConfig,
  DEFAULT_RRF_SETTINGS,
  loadRrfSettings,
  saveRrfSettings,
  validateRrfSettings,
  type RrfSettings,
} from '../lib/rrf-settings';
import {
  createWorkbenchHistoryEntry,
  clearWorkbenchHistory,
  getOrCreateWorkbenchSessionId,
  loadWorkbenchHistory,
  removeWorkbenchHistoryEntry,
  saveWorkbenchHistoryEntry,
  type WorkbenchHistoryEntry,
  type WorkbenchSnapshot,
} from '../lib/workbench-history';
import {
  applyCanonicalFrameToCandidate,
  applyStudioFrameToCandidate,
  autoSelectNearbyTrakeFrames,
  emptyTrakeFrameSlots,
  fillTextualKisAnswers,
  moveFrameToBoundary,
  normalizeFrameCandidate,
  normalizeTrakeFrameSlots,
  reorderFrames,
  sortTrakeFrames,
  toFrameCandidates,
  TRAKE_FRAME_COUNT,
  validateTrakeSequence,
} from '../lib/workbench-model';
import { buildSubmissionCsv } from '../lib/submission-csv';
import { parseAnswerCsv, type CsvImportIssue, type ImportedFrameRef } from '../lib/query-import';
import { useWorkbenchStore } from '../lib/workbench-store';
import { frameThumbnailUri } from '../lib/video-studio-model';
import {
  completeTrakeQueueItem,
  fillTrakeQueue,
  incompleteTrakeQueueCount,
  isCompleteTrakeQueueItem,
  moveTrakeQueueItem,
  removeTrakeQueueItem,
  restoreTrakeQueueFromAnswers,
  trakeQueueAnswers,
  trakeQueueKey,
  type TrakeQueueItem,
  upsertCompletedTrakeQueueItem,
} from '../lib/trake-queue-model';
import { runVqaBatch } from '../lib/vqa-batch';
import {
  DEFAULT_VQA_BATCH_SETTINGS,
  loadVqaBatchSettings,
  saveVqaBatchSettings,
  validateVqaBatchSettings,
  type VqaBatchSettings,
} from '../lib/vqa-batch-settings';
import {
  addVqaFrame,
  applyAnswerToPending,
  applyVqaBatchResults,
  completedVqaAnswers,
  fillVqaQueue,
  moveVqaQueueItem as moveVqaQueueItemModel,
  queueKey,
  removeVqaQueueItem as removeVqaQueueItemModel,
  restoreVqaQueueFromAnswers,
  updateVqaQueueItem,
  type VqaQueueItem,
} from '../lib/vqa-queue-model';
import { AnswerDrawer } from './workbench/AnswerDrawer';
import { FrameGrid } from './workbench/FrameGrid';
import {
  DEFAULT_INSPECTOR_WIDTH,
  FrameInspector,
  MAX_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
} from './workbench/FrameInspector';
import { HistoryPanel } from './workbench/HistoryPanel';
import { LlmSettingsPopover } from './workbench/LlmSettingsPopover';
import { SearchSidebar } from './workbench/SearchSidebar';
import { VideoStudioModal } from './workbench/VideoStudioModal';

interface Props {
  search: (request: SearchRequest) => Promise<SearchResponse>;
  exactFrameSearch: (request: ExactFrameSearchRequest) => Promise<SearchResponse>;
  loadFrame?: (videoId: string, frameId: number, signal?: AbortSignal) => Promise<CanonicalFrameResponse>;
  loadKeyframe?: (videoId: string, keyframeNo: number, signal?: AbortSignal) => Promise<CanonicalFrameResponse>;
  loadStudio: (videoId: string, signal?: AbortSignal) => Promise<VideoStudioResponse>;
  saveSelection: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SelectionRevision>;
  createPreview: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SubmissionPreview>;
  suggestVqaAnswer: (request: VqaAnswerRequest) => Promise<VqaAnswerSuggestion>;
  improveQuery: (request: QueryImprovementRequest) => Promise<QueryImprovementResponse>;
}

function initialEvents(): QualificationEventInput[] {
  return Array.from({ length: TRAKE_FRAME_COUNT }, (_, index) => ({
    event_id: `event-${index + 1}`,
    event_ordinal: index + 1,
    description: '',
  }));
}

function queryImproverWarningMessage(warning: string | null): string {
  switch (warning) {
    case 'query_improver_unavailable':
      return 'Query Improver chưa được cấu hình LLM. Hãy bật cấu hình LLM ở Settings hoặc cấu hình LLM_BASE_URL và LLM_MODEL cho backend.';
    case 'query_improver_failed':
      return 'LLM Query Improver không phản hồi. Hãy kiểm tra endpoint, API key và trạng thái model.';
    case 'query_improver_invalid_output':
      return 'LLM Query Improver không trả về kết quả theo định dạng có thể dùng được. Vui lòng thử lại.';
    default:
      return 'Query Improver không tạo được bản cải thiện; các ô nhập vẫn giữ nguyên.';
  }
}

interface TrakeQueryParts {
  readonly overview: string;
  readonly events: string[];
}

function parseTrakeQuery(value: string): TrakeQueryParts | null {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstEventIndex = lines.findIndex((line) => /^\d+[.)]\s*/.test(line));
  if (firstEventIndex <= 0) return null;

  const overview = lines.slice(0, firstEventIndex).join('\n').trim();
  const events = lines.slice(firstEventIndex)
    .map((line) => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  return overview && events.length > 0 ? { overview, events } : null;
}

function buildWorkbenchQuery(
  task: QualificationTask,
  description: string,
  question: string,
): { query: string; backendTask: QueryImprovementRequest['task'] } {
  const cleanDescription = description.trim();
  const cleanQuestion = question.trim();
  const query = task === 'trake'
    ? cleanDescription
    : task === 'qa'
      ? `${cleanDescription}\nCâu hỏi: ${cleanQuestion}`
      : cleanDescription;
  return {
    query,
    backendTask: task === 'qa' ? 'vqa' : task,
  };
}

function buildQueryImprovementRequest(
  task: QualificationTask,
  description: string,
  question: string,
  events: readonly QualificationEventInput[],
): QueryImprovementRequest {
  const cleanDescription = description.trim();
  const cleanQuestion = question.trim();
  const eventDescriptions = events.map((item) => item.description.trim());
  const backendTask = task === 'qa' ? 'vqa' : task;
  return {
    query: cleanDescription,
    task: backendTask,
    ...(task === 'qa' ? { question: cleanQuestion } : {}),
    ...(task === 'trake' ? { events: eventDescriptions } : {}),
  };
}

function readCsvFile(file: File): Promise<string> {
  const fileWithText = file as File & { text?: () => Promise<string> };
  if (typeof fileWithText.text === 'function') return fileWithText.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Không thể đọc nội dung CSV.'));
    });
    reader.addEventListener('error', () => reject(new Error('Không thể đọc nội dung CSV.')));
    reader.readAsText(file);
  });
}

const VQA_BATCH_CONCURRENCY = 4;
const MAX_CSV_IMPORT_BYTES = 1_000_000;
const MAX_EXACT_FRAME_BATCH_SIZE = 100;
const NOTICE_DISMISS_MS = 4_000;

type TaskWorkspaceSnapshot = WorkbenchSnapshot & { readonly history_id: string | null };
type TrakeFrameSlots = Array<FrameCandidate | null>;
type TrakeFrameSelections = Record<string, TrakeFrameSlots>;

function importedTrakeDisplayFrames(
  answers: readonly TrakeAnswer[],
  candidates: readonly FrameCandidate[],
): FrameCandidate[] {
  const candidatesByKey = new Map(candidates.map((frame) => [trakeQueueKey(frame), frame] as const));
  const seen = new Set<string>();
  return answers.flatMap((answer) => {
    const firstFrameId = answer.frame_ids[0];
    if (firstFrameId === undefined) return [];
    const frame = candidatesByKey.get(trakeQueueKey({
      video_id: answer.video_id,
      original_frame_id: firstFrameId,
    }));
    if (!frame || seen.has(frame.result_key)) return [];
    seen.add(frame.result_key);
    return [frame];
  });
}

function orderFramesByRefs(
  refs: readonly ImportedFrameRef[],
  candidates: readonly FrameCandidate[],
): FrameCandidate[] {
  const candidatesByKey = new Map(candidates.map((frame) => [queueKey(frame), frame] as const));
  const seen = new Set<string>();
  const ordered = refs.flatMap((ref) => {
    const key = `${ref.video_id}\u0000${ref.original_frame_id}`;
    const frame = candidatesByKey.get(key);
    if (!frame || seen.has(key)) return [];
    seen.add(key);
    return [frame];
  });

  return [
    ...ordered,
    ...candidates.filter((frame) => !seen.has(queueKey(frame))),
  ];
}

function buildTrakeFrameSelections(
  queue: readonly TrakeQueueItem[],
  inProgress: Readonly<TrakeFrameSelections>,
): Record<string, readonly FrameCandidate[]> {
  const selections: Record<string, readonly FrameCandidate[]> = {};
  queue.forEach((item) => {
    if (isCompleteTrakeQueueItem(item)) {
      selections[item.anchor.result_key] = item.frames.map((frame) => ({ ...frame }));
    }
  });
  Object.entries(inProgress).forEach(([resultKey, frames]) => {
    const selected = frames.filter((frame): frame is FrameCandidate => frame !== null);
    if (selected.length > 0) selections[resultKey] = selected.map((frame) => ({ ...frame }));
  });
  return selections;
}

function mergeExactFrameResponses(responses: readonly SearchResponse[]): SearchResponse {
  const first = responses[0];
  if (!first) throw new Error('Exact-frame không trả về kết quả.');

  return {
    ...first,
    degraded: responses.some((response) => response.degraded),
    unavailable_branches: Array.from(new Set(responses.flatMap((response) => response.unavailable_branches))),
    results: responses.flatMap((response) => response.results),
    warnings: Array.from(new Set(responses.flatMap((response) => response.warnings ?? []))),
  };
}

function emptyTaskWorkspaceSnapshot(task: QualificationTask): TaskWorkspaceSnapshot {
  return {
    task,
    description: '',
    question: '',
    events: initialEvents(),
    response: null,
    rankedFrames: [],
    selectedAnchor: null,
    assignedFrames: emptyTrakeFrameSlots(),
    assignedFramesByResult: {},
    answers: [],
    qaAnswer: '',
    vqaQueue: [],
    trakeQueue: [],
    history_id: null,
  };
}

export function Workbench({ exactFrameSearch, search, loadFrame, loadKeyframe, loadStudio, saveSelection, createPreview, suggestVqaAnswer, improveQuery }: Props) {
  const task = useWorkbenchStore((state) => state.task);
  const answers = useWorkbenchStore((state) => state.answers);
  const setTask = useWorkbenchStore((state) => state.setTask);
  const replaceAnswers = useWorkbenchStore((state) => state.replaceAnswers);
  const addAnswer = useWorkbenchStore((state) => state.addAnswer);
  const removeAnswer = useWorkbenchStore((state) => state.removeAnswer);
  const moveAnswer = useWorkbenchStore((state) => state.moveAnswer);
  const reset = useWorkbenchStore((state) => state.reset);

  const [description, setDescription] = useState('');
  const [question, setQuestion] = useState('');
  const [events, setEvents] = useState<QualificationEventInput[]>(initialEvents);
  const [queryImproverSettings, setQueryImproverSettings] = useState<QueryImproverSettings>({ enabled: false });
  const [queryImproverError, setQueryImproverError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [rankedFrames, setRankedFrames] = useState<FrameCandidate[]>([]);
  const [selectedAnchor, setSelectedAnchor] = useState<FrameCandidate | null>(null);
  const [activeFrame, setActiveFrame] = useState<FrameCandidate | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [assignedFramesByResult, setAssignedFramesByResult] = useState<TrakeFrameSelections>({});
  const [qaAnswer, setQaAnswer] = useState('');
  const [vqaQueue, setVqaQueue] = useState<VqaQueueItem[]>([]);
  const [trakeQueue, setTrakeQueue] = useState<TrakeQueueItem[]>([]);
  const [trakeQueueLoading, setTrakeQueueLoading] = useState(false);
  const [batchTopK, setBatchTopK] = useState('10');
  const [batchVqaLoading, setBatchVqaLoading] = useState(false);
  const [batchVqaProgress, setBatchVqaProgress] = useState<{ completed: number; total: number; failed: number } | null>(null);
  const [exactFrameResolving, setExactFrameResolving] = useState(false);
  const batchAbortRef = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<WorkbenchHistoryEntry[]>([]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);
  const [taskSnapshots, setTaskSnapshots] = useState<Partial<Record<QualificationTask, TaskWorkspaceSnapshot>>>({});
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioVideoId, setStudioVideoId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(DEFAULT_LLM_SETTINGS);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [vlmSettings, setVlmSettings] = useState<VlmSettings>(DEFAULT_VLM_SETTINGS);
  const [vlmError, setVlmError] = useState<string | null>(null);
  const [embeddingSettings, setEmbeddingSettings] = useState<EmbeddingSettings>(DEFAULT_EMBEDDING_SETTINGS);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);
  const [retrievalSettings, setRetrievalSettings] = useState<RetrievalSettings>(DEFAULT_RETRIEVAL_SETTINGS);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [rrfSettings, setRrfSettings] = useState<RrfSettings>(DEFAULT_RRF_SETTINGS);
  const [rrfError, setRrfError] = useState<string | null>(null);
  const [vqaBatchSettings, setVqaBatchSettings] = useState<VqaBatchSettings>(DEFAULT_VQA_BATCH_SETTINGS);
  const [vqaBatchError, setVqaBatchError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const historyEntriesRef = useRef<readonly WorkbenchHistoryEntry[]>([]);
  const restoredRankedQueryRef = useRef<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: (request: SearchRequest) => search(request),
  });
  const exactFrameMutation = useMutation({
    mutationFn: (request: ExactFrameSearchRequest) => exactFrameSearch(request),
  });
  const vqaAnswerMutation = useMutation({
    mutationFn: (request: VqaAnswerRequest) => suggestVqaAnswer(request),
  });
  const queryImproverMutation = useMutation({
    mutationFn: (request: QueryImprovementRequest) => improveQuery(request),
  });
  const studioQuery = useQuery({
    queryKey: ['video-studio', studioVideoId],
    queryFn: ({ signal }) => {
      if (!studioVideoId) throw new Error('Chưa chọn video để mở studio.');
      return loadStudio(studioVideoId, signal);
    },
    enabled: studioOpen && studioVideoId !== null,
  });
  const exactFrameLoader = useMemo(
    () => loadFrame && studioVideoId
      ? (frameId: number, signal?: AbortSignal) => loadFrame(studioVideoId, frameId, signal)
      : undefined,
    [loadFrame, studioVideoId],
  );
  const normalized = useMemo(
    () => response ? toFrameCandidates(response) : { frames: [], skipped: 0 },
    [response],
  );
  const vqaAnswers = useMemo(() => completedVqaAnswers(vqaQueue), [vqaQueue]);
  const vqaQueueKeys = useMemo(() => new Set(vqaQueue.map((item) => item.key)), [vqaQueue]);
  const trakeAnswers = useMemo(() => trakeQueueAnswers(trakeQueue), [trakeQueue]);
  const trakeMissingCount = useMemo(() => incompleteTrakeQueueCount(trakeQueue), [trakeQueue]);
  const trakeFrameSelections = useMemo(
    () => buildTrakeFrameSelections(trakeQueue, assignedFramesByResult),
    [assignedFramesByResult, trakeQueue],
  );
  const assignedFrames = useMemo(
    () => selectedAnchor
      ? assignedFramesByResult[selectedAnchor.result_key] ?? emptyTrakeFrameSlots()
      : emptyTrakeFrameSlots(),
    [assignedFramesByResult, selectedAnchor],
  );

  const captureSnapshot = useCallback((overrides: Partial<WorkbenchSnapshot> = {}): WorkbenchSnapshot => ({
    task,
    description: overrides.description ?? description,
    question: overrides.question ?? question,
    events: overrides.events ?? events,
    response: overrides.response !== undefined ? overrides.response : response,
    rankedFrames: overrides.rankedFrames ?? rankedFrames,
    selectedAnchor: overrides.selectedAnchor !== undefined ? overrides.selectedAnchor : selectedAnchor,
    assignedFrames: overrides.assignedFrames ?? assignedFrames,
    assignedFramesByResult: overrides.assignedFramesByResult ?? assignedFramesByResult,
    answers: overrides.answers ?? (task === 'trake' ? trakeAnswers : answers),
    qaAnswer: overrides.qaAnswer ?? qaAnswer,
    vqaQueue: overrides.vqaQueue ?? vqaQueue,
    trakeQueue: overrides.trakeQueue ?? trakeQueue,
  }), [
    answers,
    assignedFrames,
    assignedFramesByResult,
    description,
    events,
    qaAnswer,
    question,
    rankedFrames,
    response,
    selectedAnchor,
    task,
    trakeAnswers,
    trakeQueue,
    vqaQueue,
  ]);

  useEffect(() => {
    const responseQueryId = response?.query_id ?? null;
    if (responseQueryId && restoredRankedQueryRef.current === responseQueryId) {
      restoredRankedQueryRef.current = null;
      return;
    }
    setRankedFrames(normalized.frames);
  }, [normalized.frames, response?.query_id]);

  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(null), NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timeoutId);
  }, [notice]);

  useEffect(() => () => {
    batchAbortRef.current?.abort();
    reset();
  }, [reset]);

  useEffect(() => {
    sessionIdRef.current = getOrCreateWorkbenchSessionId();
    const loadedHistory = loadWorkbenchHistory();
    historyEntriesRef.current = loadedHistory;
    setHistoryEntries(loadedHistory);
    setLlmSettings(loadLlmSettings());
    setVlmSettings(loadVlmSettings());
    setEmbeddingSettings(loadEmbeddingSettings());
    setRetrievalSettings(loadRetrievalSettings());
    setRrfSettings(loadRrfSettings());
    setVqaBatchSettings(loadVqaBatchSettings());
    setQueryImproverSettings(loadQueryImproverSettings());
  }, []);

  useEffect(() => {
    historyEntriesRef.current = historyEntries;
  }, [historyEntries]);

  function persistHistoryEntries(entries: readonly WorkbenchHistoryEntry[]) {
    const next = [...entries];
    historyEntriesRef.current = next;
    setHistoryEntries(next);
  }

  function addHistorySnapshot(snapshot: WorkbenchSnapshot): WorkbenchHistoryEntry {
    const entry = createWorkbenchHistoryEntry(snapshot);
    saveWorkbenchHistoryEntry(entry);
    persistHistoryEntries(loadWorkbenchHistory());
    return entry;
  }

  function currentSessionId(): string {
    if (!sessionIdRef.current) sessionIdRef.current = getOrCreateWorkbenchSessionId();
    return sessionIdRef.current;
  }

  useEffect(() => {
    if (!activeHistoryId || !response) return;
    const currentEntry = historyEntriesRef.current.find((entry) => entry.history_id === activeHistoryId);
    if (!currentEntry) return;
    const updatedEntry = createWorkbenchHistoryEntry(captureSnapshot(), new Date(currentEntry.created_at), activeHistoryId);
    saveWorkbenchHistoryEntry(updatedEntry);
    persistHistoryEntries(loadWorkbenchHistory());
  }, [
    activeHistoryId,
    answers,
    assignedFrames,
    captureSnapshot,
    description,
    events,
    qaAnswer,
    question,
    rankedFrames,
    response,
    selectedAnchor,
    task,
    trakeQueue,
    vqaQueue,
  ]);

  function clearQueryImproverError() {
    setQueryImproverError(null);
  }

  function applyWorkspaceSnapshot(snapshot: WorkbenchSnapshot, historyId: string | null) {
    const restoredRankedFrames = snapshot.rankedFrames.length > 0
      ? snapshot.rankedFrames.map(normalizeFrameCandidate)
      : snapshot.response ? toFrameCandidates(snapshot.response).frames : [];
    const restoredAssignedFramesByResult = snapshot.assignedFramesByResult
      ? Object.fromEntries(
        Object.entries(snapshot.assignedFramesByResult).map(([resultKey, frames]) => [
          resultKey,
          normalizeTrakeFrameSlots(frames).map((frame) => frame ? normalizeFrameCandidate(frame) : null),
        ]),
      )
      : snapshot.selectedAnchor
        ? {
          [snapshot.selectedAnchor.result_key]: normalizeTrakeFrameSlots(snapshot.assignedFrames)
            .map((frame) => frame ? normalizeFrameCandidate(frame) : null),
        }
        : {};
    const restoredTrakeCandidates = [
      ...Object.values(restoredAssignedFramesByResult).flatMap((frames) => frames.filter((frame): frame is FrameCandidate => frame !== null)),
      ...(snapshot.selectedAnchor ? [normalizeFrameCandidate(snapshot.selectedAnchor)] : []),
      ...restoredRankedFrames,
    ];
    const restoredTrakeQueue = snapshot.trakeQueue
      ? snapshot.trakeQueue.map((item) => ({
        key: item.key,
        anchor: normalizeFrameCandidate(item.anchor),
        frames: item.frames.map(normalizeFrameCandidate),
      }))
      : restoreTrakeQueueFromAnswers(
        snapshot.answers.filter((answer): answer is TrakeAnswer => 'frame_ids' in answer),
        restoredTrakeCandidates,
      );
    setTask(snapshot.task);
    replaceAnswers(snapshot.task === 'trake' ? trakeQueueAnswers(restoredTrakeQueue) : snapshot.answers);
    setDescription(snapshot.description);
    setQuestion(snapshot.question);
    setEvents(snapshot.task === 'trake'
      ? initialEvents().map((event, index) => ({
        ...event,
        description: snapshot.events[index]?.description ?? '',
      }))
      : snapshot.events.map((event) => ({ ...event })));
    restoredRankedQueryRef.current = snapshot.response?.query_id ?? null;
    setResponse(snapshot.response);
    setRankedFrames(restoredRankedFrames);
    setSelectedAnchor(snapshot.selectedAnchor ? normalizeFrameCandidate(snapshot.selectedAnchor) : null);
    setActiveFrame(null);
    setAssignedFramesByResult(restoredAssignedFramesByResult);
    setQaAnswer(snapshot.qaAnswer);
    setVqaQueue(snapshot.vqaQueue.map((item) => ({
      ...item,
      thumbnail_uri: frameThumbnailUri(item.video_id, item.frame_id),
    })));
    setTrakeQueue(restoredTrakeQueue);
    setActiveHistoryId(historyId);
    setDrawerOpen(false);
    setStudioOpen(false);
    setStudioVideoId(null);
    setBatchVqaProgress(null);
    setTrakeQueueLoading(false);
    setError(null);
    setNotice(null);
  }

  function changeTask(nextTask: QualificationTask) {
    if (nextTask === task) return;
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
    const currentSnapshot: TaskWorkspaceSnapshot = { ...captureSnapshot(), history_id: activeHistoryId };
    const nextSnapshot = taskSnapshots[nextTask] ?? emptyTaskWorkspaceSnapshot(nextTask);
    setTaskSnapshots((current) => ({ ...current, [task]: currentSnapshot }));
    applyWorkspaceSnapshot(nextSnapshot, nextSnapshot.history_id);
    clearQueryImproverError();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const eventDescriptions = events.map((item) => item.description.trim()).filter(Boolean);
    const cleanDescription = description.trim();
    const cleanQuestion = question.trim();
    if (searchMutation.isPending) return;
    if (task === 'trake'
      ? !cleanDescription || eventDescriptions.length !== events.length
      : !cleanDescription) return;
    if (task === 'qa' && !cleanQuestion) return;

    const { query, backendTask } = buildWorkbenchQuery(task, description, question);

    setError(null);
    setNotice(null);
    setActiveHistoryId(null);
    restoredRankedQueryRef.current = null;
    setResponse(null);
    setSelectedAnchor(null);
    setActiveFrame(null);
    setAssignedFramesByResult({});
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
    setVqaQueue([]);
    setTrakeQueue([]);
    replaceAnswers([]);
    setTrakeQueueLoading(false);
    setBatchVqaProgress(null);
    const embeddingValidationError = validateEmbeddingSettings(embeddingSettings);
    if (embeddingValidationError) {
      setEmbeddingError(embeddingValidationError);
      setSettingsOpen(true);
      return;
    }
    const retrievalValidationError = validateRetrievalSettings(retrievalSettings);
    if (retrievalValidationError) {
      setRetrievalError(retrievalValidationError);
      setSettingsOpen(true);
      return;
    }
    const rrfValidationError = validateRrfSettings(rrfSettings);
    if (rrfValidationError) {
      setRrfError(rrfValidationError);
      return;
    }
    try {
      const embedding = buildSearchEmbeddingConfig(embeddingSettings);
      const retrieval = {
        ...buildSearchRetrievalConfig(retrievalSettings),
        ...buildSearchRrfConfig(rrfSettings),
      };
      const next = await searchMutation.mutateAsync({
        query,
        task: backendTask,
        top_k: retrieval.display_k,
        session_id: currentSessionId(),
        retrieval,
        ...(embedding ? { embedding } : {}),
      });
      const nextFrames = toFrameCandidates(next).frames;
      const snapshot = captureSnapshot({
        response: next,
        rankedFrames: nextFrames,
        selectedAnchor: null,
        assignedFrames: emptyTrakeFrameSlots(),
        assignedFramesByResult: {},
        vqaQueue: [],
      });
      const entry = addHistorySnapshot(snapshot);
      setResponse(next);
      setRankedFrames(nextFrames);
      setActiveHistoryId(entry.history_id);
      setTaskSnapshots((current) => ({ ...current, [task]: { ...snapshot, history_id: entry.history_id } }));
    } catch (reason) {
      setError(readError(reason, 'Tìm kiếm thất bại.'));
    }
  }

  async function queryByFrame(frame: FrameCandidate) {
    if (searchMutation.isPending) return;
    setError(null);
    setNotice(null);
    setActiveHistoryId(null);
    restoredRankedQueryRef.current = null;
    setResponse(null);
    setSelectedAnchor(null);
    setActiveFrame(null);
    setAssignedFramesByResult({});
    setStudioOpen(false);
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
    setVqaQueue([]);
    setTrakeQueue([]);
    replaceAnswers([]);
    setTrakeQueueLoading(false);
    setBatchVqaProgress(null);

    const embeddingValidationError = validateEmbeddingSettings(embeddingSettings);
    if (embeddingValidationError) {
      setEmbeddingError(embeddingValidationError);
      setSettingsOpen(true);
      return;
    }
    const retrievalValidationError = validateRetrievalSettings(retrievalSettings);
    if (retrievalValidationError) {
      setRetrievalError(retrievalValidationError);
      setSettingsOpen(true);
      return;
    }
    const rrfValidationError = validateRrfSettings(rrfSettings);
    if (rrfValidationError) {
      setRrfError(rrfValidationError);
      return;
    }

    try {
      const embedding = buildSearchEmbeddingConfig(embeddingSettings);
      const retrieval = {
        ...buildSearchRetrievalConfig(retrievalSettings),
        ...buildSearchRrfConfig(rrfSettings),
      };
      const next = await searchMutation.mutateAsync({
        query: '',
        task: task === 'qa' ? 'vqa' : task,
        top_k: retrieval.display_k,
        session_id: currentSessionId(),
        retrieval,
        frame_query: {
          video_id: frame.video_id,
          original_frame_id: frame.original_frame_id,
        },
        ...(embedding ? { embedding } : {}),
      });
      const nextFrames = toFrameCandidates(next).frames;
      const snapshot = captureSnapshot({
        response: next,
        rankedFrames: nextFrames,
        selectedAnchor: null,
        assignedFrames: emptyTrakeFrameSlots(),
        assignedFramesByResult: {},
        vqaQueue: [],
      });
      const entry = addHistorySnapshot(snapshot);
      setResponse(next);
      setRankedFrames(nextFrames);
      setActiveHistoryId(entry.history_id);
      setTaskSnapshots((current) => ({ ...current, [task]: { ...snapshot, history_id: entry.history_id } }));
      setNotice(`Đã tìm kiếm các frame tương tự ${frame.video_id} · frame ${frame.original_frame_id}.`);
    } catch (reason) {
      setError(readError(reason, 'Tìm kiếm bằng frame thất bại.'));
    }
  }

  function clearExactFrameWorkspace() {
    setError(null);
    setNotice(null);
    setActiveHistoryId(null);
    restoredRankedQueryRef.current = null;
    setResponse(null);
    setSelectedAnchor(null);
    setActiveFrame(null);
    setAssignedFramesByResult({});
    setStudioOpen(false);
    setStudioVideoId(null);
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
    setVqaQueue([]);
    setTrakeQueue([]);
    replaceAnswers([]);
    setTrakeQueueLoading(false);
    setBatchVqaProgress(null);
  }

  async function runExactFrameLookup(
    frameRefs: readonly ImportedFrameRef[],
    importedAnswers: readonly QualificationAnswer[] = [],
    importIssues: readonly CsvImportIssue[] = [],
  ) {
    if (exactFrameMutation.isPending) return;
    const uniqueRefs = Array.from(
      new Map(frameRefs.map((frame) => [`${frame.video_id}:${frame.original_frame_id}`, frame])).values(),
    );
    if (uniqueRefs.length === 0) {
      setError('Không có frame hợp lệ để tra cứu.');
      return;
    }

    clearExactFrameWorkspace();
    try {
      const exactFrameResponses: SearchResponse[] = [];
      const exactTask = task === 'qa' ? 'vqa' : task;
      const sessionId = currentSessionId();
      for (let offset = 0; offset < uniqueRefs.length; offset += MAX_EXACT_FRAME_BATCH_SIZE) {
        const batch = uniqueRefs.slice(offset, offset + MAX_EXACT_FRAME_BATCH_SIZE);
        exactFrameResponses.push(await exactFrameMutation.mutateAsync({
          task: exactTask,
          frames: [...batch],
          session_id: sessionId,
        }));
      }
      const next = mergeExactFrameResponses(exactFrameResponses);
      const nextFrames = toFrameCandidates(next).frames;
      const availableFrameKeys = new Set(nextFrames.map((frame) => `${frame.video_id}:${frame.original_frame_id}`));
      const importedFrameAnswers = [...importedAnswers];
      const importedVqaAnswers = task === 'qa'
        ? importedFrameAnswers.filter((answer): answer is QaAnswer => 'answer' in answer)
        : [];
      const importedTrakeAnswers = task === 'trake'
        ? importedFrameAnswers.filter((answer): answer is TrakeAnswer => 'frame_ids' in answer)
        : [];
      const orderedFrames = orderFramesByRefs(frameRefs, nextFrames);
      const displayFrames = importedTrakeAnswers.length > 0
        ? importedTrakeDisplayFrames(importedTrakeAnswers, orderedFrames)
        : orderedFrames;
      const restoredVqaQueue = task === 'qa'
        ? restoreVqaQueueFromAnswers(importedVqaAnswers, orderedFrames)
        : [];
      const restoredTrakeQueue = task === 'trake'
        ? restoreTrakeQueueFromAnswers(
          importedTrakeAnswers,
          orderedFrames,
        )
        : [];
      const restoredTrakeSelections: TrakeFrameSelections = task === 'trake'
        ? Object.fromEntries(
          Object.entries(buildTrakeFrameSelections(restoredTrakeQueue, {})).map(([resultKey, frames]) => [
            resultKey,
            normalizeTrakeFrameSlots(frames),
          ]),
        )
        : {};
      const restoredAnswers = task === 'trake'
        ? trakeQueueAnswers(restoredTrakeQueue)
        : task === 'qa'
          ? completedVqaAnswers(restoredVqaQueue)
          : importedFrameAnswers.filter((answer) => (
            'frame_id' in answer && availableFrameKeys.has(`${answer.video_id}:${answer.frame_id}`)
          ));

      setVqaQueue(restoredVqaQueue);
      setTrakeQueue(restoredTrakeQueue);
      setAssignedFramesByResult(restoredTrakeSelections);
      replaceAnswers(restoredAnswers);
      const snapshot = captureSnapshot({
        response: next,
        rankedFrames: displayFrames,
        selectedAnchor: null,
        assignedFrames: emptyTrakeFrameSlots(),
        assignedFramesByResult: restoredTrakeSelections,
        answers: restoredAnswers,
        vqaQueue: restoredVqaQueue,
        trakeQueue: restoredTrakeQueue,
      });
      const entry = addHistorySnapshot(snapshot);
      restoredRankedQueryRef.current = next.query_id;
      setResponse(next);
      setRankedFrames(displayFrames);
      setActiveHistoryId(entry.history_id);
      setTaskSnapshots((current) => ({ ...current, [task]: { ...snapshot, history_id: entry.history_id } }));

      const unavailableCount = uniqueRefs.filter((frame) => (
        !availableFrameKeys.has(`${frame.video_id}:${frame.original_frame_id}`)
      )).length;
      const skippedCount = importIssues.length + unavailableCount;
      const importedLabel = importedAnswers.length > 0
        ? ` Đã khôi phục ${restoredAnswers.length} đáp án.`
        : '';
      const skippedLabel = skippedCount > 0
        ? ` Bỏ qua ${skippedCount} dòng/frame không hợp lệ hoặc không khả dụng.`
        : '';
      setNotice(`Đã tra cứu ${nextFrames.length}/${uniqueRefs.length} frame theo ID.${importedLabel}${skippedLabel}`);
    } catch (reason) {
      setError(readError(reason, 'Tra cứu frame theo ID thất bại.'));
    }
  }

  async function queryByIdentifier(
    videoId: string,
    idType: 'original_frame_id' | 'keyframe_no',
    frameId: number,
  ) {
    if (exactFrameMutation.isPending || exactFrameResolving) return;
    if (idType === 'original_frame_id') {
      await runExactFrameLookup([{ video_id: videoId, original_frame_id: frameId }]);
      return;
    }
    if (!loadKeyframe) {
      setError('Chưa cấu hình API để phân giải keyframe ordinal.');
      return;
    }
    setExactFrameResolving(true);
    clearExactFrameWorkspace();
    try {
      const canonical = await loadKeyframe(videoId, frameId);
      await runExactFrameLookup([{
        video_id: canonical.video_id,
        original_frame_id: canonical.original_frame_id,
      }]);
    } catch (reason) {
      setError(readError(reason, 'Không thể phân giải keyframe ordinal.'));
    } finally {
      setExactFrameResolving(false);
    }
  }

  async function importAnswerCsv(file: File) {
    try {
      if (file.size > MAX_CSV_IMPORT_BYTES) {
        throw new Error('CSV không được vượt quá 1 MB.');
      }
      if (!/\.csv$/i.test(file.name)) {
        throw new Error('Chỉ hỗ trợ file có phần mở rộng .csv.');
      }
      const contentType = file.type.trim().toLowerCase();
      if (contentType && !['text/csv', 'application/csv', 'application/vnd.ms-excel'].includes(contentType)) {
        throw new Error('Định dạng file không phải CSV.');
      }
      const parsed = parseAnswerCsv(await readCsvFile(file), task);
      if (parsed.frame_refs.length === 0) {
        setError(parsed.issues.length > 0
          ? `CSV không có dòng hợp lệ để tra cứu (${parsed.issues.length} dòng bị bỏ qua).`
          : 'CSV không có dòng đáp án hợp lệ để tra cứu.');
        return;
      }
      await runExactFrameLookup(parsed.frame_refs, parsed.answers, parsed.issues);
    } catch (reason) {
      setError(readError(reason, 'Không thể đọc file CSV đáp án.'));
    }
  }

  function restoreHistoryEntry(entry: WorkbenchHistoryEntry) {
    batchAbortRef.current?.abort();
    batchAbortRef.current = null;
    setTaskSnapshots((current) => ({ ...current, [entry.task]: { ...entry, history_id: entry.history_id } }));
    applyWorkspaceSnapshot(entry, entry.history_id);
    setHistoryOpen(false);
    clearQueryImproverError();
  }

  function removeHistoryEntry(historyId: string) {
    removeWorkbenchHistoryEntry(historyId);
    const next = loadWorkbenchHistory();
    persistHistoryEntries(next);
    if (activeHistoryId === historyId) setActiveHistoryId(null);
  }

  function clearHistory() {
    clearWorkbenchHistory();
    persistHistoryEntries([]);
    setActiveHistoryId(null);
  }

  async function createImprovedQuery() {
    const eventDescriptions = events.map((item) => item.description.trim());
    const cleanDescription = description.trim();
    const cleanQuestion = question.trim();
    if (task === 'trake'
      ? !cleanDescription || eventDescriptions.length !== events.length || eventDescriptions.some((item) => !item)
      : !cleanDescription) return;
    if (task === 'qa' && !cleanQuestion) return;

    const improvementRequest = buildQueryImprovementRequest(task, description, question, events);
    setQueryImproverError(null);
    setNotice(null);
    try {
      const frontendLlm = llmSettings.enabled && validateLlmSettings(llmSettings) === null
        ? buildVqaLlmConfig(llmSettings)
        : undefined;
      const result = await queryImproverMutation.mutateAsync({
        ...improvementRequest,
        ...(frontendLlm ? { llm: frontendLlm } : {}),
      });
      if (result.warning) {
        setQueryImproverError(queryImproverWarningMessage(result.warning));
        setNotice('Không thể cải thiện; các ô nhập vẫn giữ query gốc.');
        return;
      }

      if (task === 'qa') {
        if (!result.improved_question?.trim()) {
          setQueryImproverError('Query Improver không trả về câu hỏi tiếng Anh hợp lệ.');
          return;
        }
        setDescription(result.improved_query);
        setQuestion(result.improved_question);
        setNotice('Đã cải thiện query và câu hỏi tiếng Anh trực tiếp trong ô nhập.');
      } else if (task === 'trake') {
        const improvedEvents = result.improved_events?.map((item) => item.trim()).filter(Boolean);
        if (improvedEvents && improvedEvents.length === events.length) {
          setDescription(result.improved_query);
          setEvents((current) => current.map((item, index) => ({
            ...item,
            description: improvedEvents[index] ?? item.description,
          })));
        } else {
          const improvedTrakeQuery = parseTrakeQuery(result.improved_query);
          if (!improvedTrakeQuery || improvedTrakeQuery.events.length !== events.length) {
            setQueryImproverError('Query Improver không giữ đúng query chính và số lượng event TRAKE.');
            return;
          }
          setDescription(improvedTrakeQuery.overview);
          setEvents((current) => current.map((item, index) => ({
            ...item,
            description: improvedTrakeQuery.events[index] ?? item.description,
          })));
        }
        setNotice('Đã cải thiện query chính và các event TRAKE trực tiếp trong ô nhập.');
      } else {
        setDescription(result.improved_query);
        setNotice('Đã cải thiện query tiếng Anh trực tiếp trong ô nhập.');
      }
    } catch (reason) {
      setQueryImproverError(readError(reason, 'Không thể cải thiện query.'));
      setNotice(llmSettings.enabled && validateLlmSettings(llmSettings) !== null
        ? 'Cấu hình LLM frontend chưa hợp lệ; backend sẽ được dùng nếu có.'
        : null);
    }
  }

  function saveQueryImproverSettingsForSession() {
    saveQueryImproverSettings(queryImproverSettings);
    setNotice(queryImproverSettings.enabled ? 'Đã bật Query Improver.' : 'Đã tắt Query Improver.');
  }

  function resetQueryImproverSettings() {
    const defaults = { enabled: false };
    setQueryImproverSettings(defaults);
    saveQueryImproverSettings(defaults);
    clearQueryImproverError();
    setNotice('Đã tắt Query Improver.');
  }

  function selectSearchFrame(frame: FrameCandidate) {
    setSelectedAnchor(frame);
    setActiveFrame(frame);
    const existingAnswer = task === 'qa'
      ? vqaQueue.find((item) => item.key === queueKey(frame))?.answer ?? ''
      : '';
    setQaAnswer(existingAnswer);
    setError(null);
    void enrichSelectedSearchFrame(frame);
  }

  async function enrichSelectedSearchFrame(frame: FrameCandidate) {
    if (!loadFrame) return;
    try {
      const canonical = await loadFrame(frame.video_id, frame.original_frame_id);
      const enriched = applyCanonicalFrameToCandidate(frame, canonical);
      setActiveFrame((current) => current?.result_key === frame.result_key ? enriched : current);
      setSelectedAnchor((current) => current?.result_key === frame.result_key ? enriched : current);
      setRankedFrames((current) => current.map((candidate) => (
        candidate.result_key === frame.result_key ? enriched : candidate
      )));
    } catch {
      setNotice('Không thể tải thêm bằng chứng OCR/ASR; vẫn giữ bằng chứng từ kết quả tìm kiếm.');
    }
  }

  function openStudio() {
    if (!activeFrame) return;
    setStudioVideoId(activeFrame.video_id);
    setStudioOpen(true);
  }

  function selectStudioFrame(frame: StudioFrame) {
    if (!selectedAnchor || !studioQuery.data) return;
    const representative = applyStudioFrameToCandidate(selectedAnchor, frame, studioQuery.data.asr_spans);
    setActiveFrame(representative);
    setSelectedAnchor(representative);
    setRankedFrames((frames) => frames.map((candidate) => (
      candidate.result_key === representative.result_key ? representative : candidate
    )));
    setNotice(frame.is_exact_frame && frame.annotation_source_frame_id !== null && frame.annotation_source_frame_id !== frame.original_frame_id
      ? `Đã chọn canonical frame ${frame.original_frame_id}; annotation lấy từ frame gần nhất ${frame.annotation_source_frame_id}.`
      : `Đã chọn frame ${frame.original_frame_id} làm bằng chứng hiện tại.`);
  }

  function selectStudioFrames(frames: readonly StudioFrame[]) {
    if (!selectedAnchor || !studioQuery.data || frames.length !== TRAKE_FRAME_COUNT) return;
    const selectionKey = selectedAnchor.result_key;
    const representatives = sortTrakeFrames(frames.map((frame) => (
      applyStudioFrameToCandidate(selectedAnchor, frame, studioQuery.data.asr_spans)
    )));
    const representative = representatives[0];
    if (!representative) return;
    const normalizedRepresentatives = normalizeTrakeFrameSlots(representatives);
    setAssignedFramesByResult((current) => ({
      ...current,
      [selectionKey]: normalizedRepresentatives,
    }));
    setActiveFrame(representative);
    setSelectedAnchor(representative);
    setRankedFrames((current) => current.map((candidate) => (
      candidate.result_key === representative.result_key ? representative : candidate
    )));
    setNotice(`Đã chọn đủ 4 frame TRAKE: ${representatives.map((frame) => frame.original_frame_id).join(' → ')}.`);
  }

  function selectAssignedFrame(index: number) {
    const frame = selectedAnchor ? assignedFramesByResult[selectedAnchor.result_key]?.[index] : undefined;
    if (!frame) return;
    setActiveFrame(frame);
    setSelectedAnchor(frame);
  }

  function autoSelectNearbyTrakeFramesForAnchor() {
    if (!selectedAnchor) return;
    const availableFrames = studioQuery.data?.video.video_id === selectedAnchor.video_id
      ? studioQuery.data.frames
      : rankedFrames.filter((frame) => frame.video_id === selectedAnchor.video_id);
    const asrSpans = studioQuery.data?.video.video_id === selectedAnchor.video_id
      ? studioQuery.data.asr_spans
      : [];
    const selected = autoSelectNearbyTrakeFrames(selectedAnchor, availableFrames, asrSpans);
    if (selected.length !== TRAKE_FRAME_COUNT || !validateTrakeSequence(selected)) {
      setError('Không đủ frame thực tế cùng video để tự động chọn đủ 4 frame TRAKE.');
      return;
    }
    const normalized = normalizeTrakeFrameSlots(selected);
    const selectionKey = selectedAnchor.result_key;
    setAssignedFramesByResult((current) => ({
      ...current,
      [selectionKey]: normalized,
    }));
    const firstFrame = selected[0] ?? selectedAnchor;
    setActiveFrame(firstFrame);
    setNotice(`Đã tự động chọn 4 frame: ${selected.map((frame) => frame.original_frame_id).join(' → ')}.`);
  }

  function fillTrakeAnswerQueue() {
    if (task !== 'trake' || rankedFrames.length === 0) return;
    setTrakeQueue((current) => fillTrakeQueue(current, rankedFrames, 100));
    setError(null);
    setNotice(`Đã nạp tối đa 100 retrieval frame vào hàng đợi TRAKE (${Math.min(100, rankedFrames.length)} frame).`);
  }

  async function completeMissingTrakeQueue() {
    if (task !== 'trake' || trakeQueueLoading || trakeMissingCount === 0) return;

    setTrakeQueueLoading(true);
    setError(null);
    setNotice(null);
    const studioCache = new Map<string, Promise<VideoStudioResponse | null>>();
    const getStudio = (videoId: string): Promise<VideoStudioResponse | null> => {
      const cached = studioCache.get(videoId);
      if (cached) return cached;
      const request = loadStudio(videoId).catch(() => null);
      studioCache.set(videoId, request);
      return request;
    };

    try {
      const nextItems = await Promise.all(trakeQueue.map(async (item) => {
        if (isCompleteTrakeQueueItem(item)) return item;

        const rankedForVideo = rankedFrames.filter((frame) => frame.video_id === item.anchor.video_id);
        const studio = rankedForVideo.length >= TRAKE_FRAME_COUNT ? null : await getStudio(item.anchor.video_id);
        const availableFrames = studio
          ? [...rankedForVideo, ...studio.frames]
          : rankedForVideo;
        const selected = autoSelectNearbyTrakeFrames(item.anchor, availableFrames, studio?.asr_spans ?? []);
        return selected.length === TRAKE_FRAME_COUNT && validateTrakeSequence(selected)
          ? completeTrakeQueueItem(item, selected)
          : item;
      }));
      const completedCount = nextItems.filter(isCompleteTrakeQueueItem).length;
      const remainingCount = nextItems.length - completedCount;
      setTrakeQueue(nextItems);
      setNotice(remainingCount > 0
        ? `Đã chọn đủ 4 frame cho ${completedCount} item; còn ${remainingCount} item thiếu frame thực tế.`
        : `Đã chọn đủ 4 frame cho ${completedCount} câu trả lời TRAKE.`);
    } finally {
      setTrakeQueueLoading(false);
    }
  }

  function exportRankedTrakeCsv() {
    if (task !== 'trake' || !response?.query_id || rankedFrames.length === 0) return;

    if (trakeAnswers.length === 0) {
      setError('Không có đáp án TRAKE để xuất CSV.');
      return;
    }

    try {
      const csv = buildSubmissionCsv('trake', trakeAnswers);
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `aic-${safeFilenamePart(response.query_id)}-trake.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setNotice(`Đã xuất CSV ${trakeAnswers.length} chuỗi TRAKE.`);
    } catch (reason) {
      setError(readError(reason, 'Không thể xuất CSV TRAKE.'));
    }
  }

  function resizeInspector(width: number) {
    const boundedWidth = Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, Math.round(width)));
    setInspectorWidth(boundedWidth);
  }

  function addFrameToVqaQueue(frame: FrameCandidate) {
    const key = queueKey(frame);
    if (vqaQueue.length >= 100 && !vqaQueueKeys.has(key)) {
      setError('Hàng đợi đã đạt giới hạn 100 frame.');
      return;
    }
    setVqaQueue((current) => addVqaFrame(current, frame));
    setError(null);
    setNotice(`Đã thêm frame ${frame.original_frame_id} vào hàng đợi.`);
  }

  function moveFrameToEdge(frame: FrameCandidate, boundary: 'top' | 'bottom') {
    setRankedFrames((current) => {
      const from = current.findIndex((candidate) => candidate.result_key === frame.result_key);
      return from < 0 ? current : moveFrameToBoundary(current, from, boundary);
    });
    setNotice(boundary === 'top'
      ? `Đã upvote frame ${frame.original_frame_id}, đưa lên đầu.`
      : `Đã downvote frame ${frame.original_frame_id}, đưa xuống cuối.`);
  }

  function fillVqaAnswerQueue() {
    setVqaQueue((current) => fillVqaQueue(current, rankedFrames, 100));
    setNotice(`Đã fill hàng đợi theo thứ tự hiện tại (${Math.min(100, rankedFrames.length)} frame).`);
  }

  function fillTextualKisQueue() {
    if (task !== 'textual_kis') return;
    replaceAnswers(fillTextualKisAnswers(answers as readonly TextualKisAnswer[], rankedFrames, 100));
    setNotice(`Đã nạp tối đa 100 frame KIS vào hàng đợi (${Math.min(100, rankedFrames.length)} frame).`);
  }

  function applyAnswerToAllPending(answer: string) {
    setVqaQueue((current) => applyAnswerToPending(current, answer));
    setNotice('Đã áp dụng answer cho toàn bộ frame pending.');
  }

  function removeVqaQueueItem(key: string) {
    setVqaQueue((current) => removeVqaQueueItemModel(current, key));
  }

  function moveVqaQueueItem(from: number, to: number) {
    setVqaQueue((current) => moveVqaQueueItemModel(current, from, to));
  }

  function parseBatchTopK(): number | null {
    const parsed = Number(batchTopK);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) return null;
    return parsed;
  }

  async function runBatchVqa() {
    if (task !== 'qa' || !response?.query_id || !question.trim() || batchVqaLoading) return;
    const limit = parseBatchTopK();
    if (limit === null) {
      setError('Top-K batch VQA phải là số nguyên từ 1 đến 100.');
      return;
    }

    const queryId = response.query_id;
    const questionText = question.trim();
    const llm = buildVqaLlmConfig(llmSettings);
    const vlm = buildVqaVlmConfig(vlmSettings);
    const alreadyAnswered = new Set(vqaQueue.filter((item) => item.status === 'answered').map((item) => item.key));
    const controller = new AbortController();
    batchAbortRef.current = controller;
    setBatchVqaLoading(true);
    setBatchVqaProgress({ completed: 0, total: Math.min(limit, rankedFrames.length), failed: 0 });
    setError(null);
    setNotice(null);

    try {
      const results = await runVqaBatch({
        frames: rankedFrames,
        limit,
        signal: controller.signal,
        concurrency: VQA_BATCH_CONCURRENCY,
        requestDelayMs: vqaBatchSettings.request_delay_ms,
        shouldSkip: (frame) => alreadyAnswered.has(queueKey(frame)),
        onProgress: setBatchVqaProgress,
        answer: (frame) => vqaAnswerMutation.mutateAsync({
          query_id: queryId,
          question: questionText,
          video_id: frame.video_id,
          original_frame_id: frame.original_frame_id,
          ...(llm ? { llm } : {}),
          ...(vlm ? { vlm } : {}),
        }),
      });

      const recordableResults = results.filter((item) => item.status !== 'skipped');
      setVqaQueue((current) => applyVqaBatchResults(current, recordableResults));
      const activeFrameAnswer = activeFrame
        ? recordableResults.find((item) => queueKey(item.frame) === queueKey(activeFrame))?.answer?.trim()
        : undefined;
      if (activeFrameAnswer) setQaAnswer(activeFrameAnswer);
      const answeredCount = results.filter((item) => item.status === 'answered').length;
      const failedCount = results.filter((item) => item.status === 'error' || item.status === 'needs_more_evidence' || item.status === 'abstained').length;
      setNotice(controller.signal.aborted
        ? `Đã dừng batch VQA sau ${results.length}/${Math.min(limit, rankedFrames.length)} frame; đã ghi ${recordableResults.length} kết quả vào hàng đợi.`
        : `Đã xử lý ${results.length} frame: ${answeredCount} answered${failedCount ? `, ${failedCount} cần kiểm tra` : ''}; đã ghi ${recordableResults.length} kết quả vào hàng đợi.`);
    } catch (reason) {
      if (!controller.signal.aborted) setError(readError(reason, 'Batch VQA thất bại.'));
    } finally {
      if (batchAbortRef.current === controller) batchAbortRef.current = null;
      setBatchVqaLoading(false);
    }
  }

  function stopBatchVqa() {
    batchAbortRef.current?.abort();
  }

  function addCurrentAnswer() {
    if (!activeFrame || !selectedAnchor) return;
    const currentQueueCount = task === 'qa' ? vqaQueue.length : task === 'trake' ? trakeQueue.length : answers.length;
    const activeKey = queueKey(activeFrame);
    const trakeKey = trakeQueueKey(selectedAnchor);
    const hasExistingTrakeItem = trakeQueue.some((item) => item.key === trakeKey);
    if (currentQueueCount >= 100 && (task === 'qa'
      ? !vqaQueueKeys.has(activeKey)
      : task === 'trake'
        ? !hasExistingTrakeItem
        : true)) {
      setError('Hàng đợi đã đạt giới hạn 100 đáp án.');
      return;
    }

    if (task === 'textual_kis') {
      addAnswer({ video_id: activeFrame.video_id, frame_id: activeFrame.original_frame_id } satisfies TextualKisAnswer);
    } else if (task === 'qa') {
      if (!qaAnswer.trim()) {
        setError('Hãy nhập câu trả lời trước khi thêm đáp án.');
        return;
      }
      setVqaQueue((current) => {
        const withFrame = addVqaFrame(current, activeFrame);
        return updateVqaQueueItem(withFrame, activeKey, { status: 'answered', answer: qaAnswer.trim() });
      });
      setQaAnswer('');
    } else {
      const sequence = sortTrakeFrames(assignedFrames.filter((frame): frame is FrameCandidate => frame !== null));
      if (sequence.length !== TRAKE_FRAME_COUNT || !validateTrakeSequence(sequence)) {
        setError('TRAKE cần chọn đủ 4 frame, cùng video và tăng dần theo thời gian.');
        return;
      }
      setTrakeQueue((current) => upsertCompletedTrakeQueueItem(current, selectedAnchor, sequence, 100));
      const selectionKey = selectedAnchor.result_key;
      setAssignedFramesByResult((current) => {
        const { [selectionKey]: _removed, ...remaining } = current;
        return remaining;
      });
    }
    setError(null);
    setNotice('Đã thêm frame vào hàng đợi đáp án.');
  }

  async function suggestAnswer() {
    if (task !== 'qa' || !response?.query_id || !activeFrame || !question.trim()) return;
    setError(null);
    setNotice(null);
    try {
      const llm = buildVqaLlmConfig(llmSettings);
      const vlm = buildVqaVlmConfig(vlmSettings);
      const suggestion = await vqaAnswerMutation.mutateAsync({
        query_id: response.query_id,
        question: question.trim(),
        video_id: activeFrame.video_id,
        original_frame_id: activeFrame.original_frame_id,
        ...(llm ? { llm } : {}),
        ...(vlm ? { vlm } : {}),
      });
      if (suggestion.answer_status === 'answered' && suggestion.answer?.trim()) {
        setQaAnswer(suggestion.answer.trim());
        setNotice('LLM đã gợi ý câu trả lời. Hãy kiểm tra trước khi lưu.');
      } else {
        setNotice(suggestion.answer_status === 'needs_more_evidence'
          ? 'LLM chưa đủ bằng chứng để trả lời frame này.'
          : 'LLM không đưa ra câu trả lời an toàn cho frame này.');
      }
    } catch (reason) {
      setError(readError(reason, 'Không thể sinh gợi ý câu trả lời.'));
    }
  }

  function saveSettings() {
    const validationError = validateLlmSettings(llmSettings);
    if (validationError) {
      setSettingsError(validationError);
      return;
    }
    saveLlmSettings(llmSettings);
    setSettingsError(null);
    setSettingsOpen(false);
    setNotice(llmSettings.enabled ? 'Đã lưu cấu hình LLM cho frontend.' : 'Đã tắt cấu hình LLM riêng của frontend.');
  }

  function resetSettings() {
    setLlmSettings({ ...DEFAULT_LLM_SETTINGS });
    saveLlmSettings(DEFAULT_LLM_SETTINGS);
    setSettingsError(null);
  }

  function saveVlmSettingsForSession() {
    const validationError = validateVlmSettings(vlmSettings);
    if (validationError) {
      setVlmError(validationError);
      return;
    }
    saveVlmSettings(vlmSettings);
    setVlmError(null);
    setSettingsOpen(false);
    setNotice(vlmSettings.enabled ? 'Đã lưu cấu hình VLM cho MoreVQA.' : 'Đã tắt cấu hình VLM cho MoreVQA.');
  }

  function resetVlmSettings() {
    setVlmSettings({ ...DEFAULT_VLM_SETTINGS });
    saveVlmSettings(DEFAULT_VLM_SETTINGS);
    setVlmError(null);
  }

  function saveEmbeddingSettingsForSession() {
    const validationError = validateEmbeddingSettings(embeddingSettings);
    if (validationError) {
      setEmbeddingError(validationError);
      return;
    }
    saveEmbeddingSettings(embeddingSettings);
    setEmbeddingError(null);
    setSettingsOpen(false);
    setNotice(embeddingSettings.enabled
      ? 'Đã lưu cấu hình embedding cho frontend.'
      : 'Đã tắt cấu hình embedding riêng của frontend.');
  }

  function resetEmbeddingSettings() {
    setEmbeddingSettings({ ...DEFAULT_EMBEDDING_SETTINGS });
    saveEmbeddingSettings(DEFAULT_EMBEDDING_SETTINGS);
    setEmbeddingError(null);
  }

  function saveRetrievalSettingsForSession() {
    const validationError = validateRetrievalSettings(retrievalSettings);
    if (validationError) {
      setRetrievalError(validationError);
      return;
    }
    saveRetrievalSettings(retrievalSettings);
    setRetrievalError(null);
    setSettingsOpen(false);
    setNotice('Đã lưu cài đặt số lượng frame và candidate cho frontend.');
  }

  function resetRetrievalSettings() {
    setRetrievalSettings({ ...DEFAULT_RETRIEVAL_SETTINGS });
    saveRetrievalSettings(DEFAULT_RETRIEVAL_SETTINGS);
    setRetrievalError(null);
  }

  function saveRrfSettingsForSession() {
    const validationError = validateRrfSettings(rrfSettings);
    if (validationError) {
      setRrfError(validationError);
      return;
    }
    saveRrfSettings(rrfSettings);
    setRrfError(null);
    setNotice('Đã lưu cấu hình RRF cho frontend.');
  }

  function resetRrfSettings() {
    const defaults = {
      ...DEFAULT_RRF_SETTINGS,
      weights: { ...DEFAULT_RRF_SETTINGS.weights },
    };
    setRrfSettings(defaults);
    saveRrfSettings(defaults);
    setRrfError(null);
  }

  function saveVqaBatchSettingsForSession() {
    const validationError = validateVqaBatchSettings(vqaBatchSettings);
    if (validationError) {
      setVqaBatchError(validationError);
      return;
    }
    saveVqaBatchSettings(vqaBatchSettings);
    setVqaBatchError(null);
    setSettingsOpen(false);
    setNotice('Đã lưu khoảng chờ batch VQA.');
  }

  function resetVqaBatchSettings() {
    setVqaBatchSettings({ ...DEFAULT_VQA_BATCH_SETTINGS });
    saveVqaBatchSettings(DEFAULT_VQA_BATCH_SETTINGS);
    setVqaBatchError(null);
  }

  return (
    <main className="app-shell">
      <header className="app-topbar">
        <a className="brand" href="#main-workspace" aria-label="AIC Search">
          <span>AIC</span> Search
        </a>
        <div className="topbar-actions">
          {response?.confidence && (
            <span className={`confidence-badge ${response.degraded ? 'degraded' : ''}`}>
              {response.degraded ? 'Suy giảm' : 'Tin cậy'} · {Math.round(response.confidence.score * 100)}%
            </span>
          )}
          <button
            type="button"
            className="quiet-button settings-trigger"
            aria-expanded={settingsOpen}
            aria-controls="llm-settings"
            onClick={() => {
              setSettingsError(null);
              setVlmError(null);
              setEmbeddingError(null);
              setRetrievalError(null);
              setRrfError(null);
              setVqaBatchError(null);
              setSettingsOpen((open) => !open);
            }}
          >
            Cài đặt
          </button>
          <button type="button" className="answer-badge" onClick={() => setDrawerOpen(true)}>
            Đáp án ({task === 'qa' ? vqaQueue.length : task === 'trake' ? trakeQueue.length : answers.length})
          </button>
          <button
            type="button"
            className="quiet-button history-trigger"
            aria-expanded={historyOpen}
            aria-controls="history-modal-title"
            onClick={() => setHistoryOpen(true)}
          >
            Lịch Sử
          </button>
        </div>
        {settingsOpen && (
          <LlmSettingsPopover
            settings={llmSettings}
            error={settingsError}
            onChange={setLlmSettings}
            onSave={saveSettings}
            onReset={resetSettings}
            vlmSettings={vlmSettings}
            vlmError={vlmError}
            onVlmChange={setVlmSettings}
            onVlmSave={saveVlmSettingsForSession}
            onVlmReset={resetVlmSettings}
            vqaBatchSettings={vqaBatchSettings}
            vqaBatchError={vqaBatchError}
            onVqaBatchChange={setVqaBatchSettings}
            onVqaBatchSave={saveVqaBatchSettingsForSession}
            onVqaBatchReset={resetVqaBatchSettings}
            embeddingSettings={embeddingSettings}
            embeddingError={embeddingError}
            onEmbeddingChange={setEmbeddingSettings}
            onEmbeddingSave={saveEmbeddingSettingsForSession}
            onEmbeddingReset={resetEmbeddingSettings}
            onClose={() => setSettingsOpen(false)}
          />
        )}
      </header>

      <div className="workbench-layout" id="main-workspace">
        <SearchSidebar
          task={task}
          displayK={retrievalSettings.display_k}
          rrfSettings={rrfSettings}
          rrfError={rrfError}
          retrievalSettings={retrievalSettings}
          retrievalError={retrievalError}
          description={description}
          question={question}
          events={events}
          pending={searchMutation.isPending || exactFrameMutation.isPending || exactFrameResolving}
          onTaskChange={changeTask}
          onDescriptionChange={(value) => { setDescription(value); clearQueryImproverError(); }}
          onQuestionChange={(value) => { setQuestion(value); clearQueryImproverError(); }}
          onEventChange={(eventId, value) => {
            setEvents((current) => current.map((item) => (
              item.event_id === eventId ? { ...item, description: value } : item
            )));
            clearQueryImproverError();
          }}
          queryImproverEnabled={queryImproverSettings.enabled}
          queryImproverPending={queryImproverMutation.isPending}
          queryImproverError={queryImproverError}
          onQueryImproverChange={(enabled) => {
            setQueryImproverSettings((current) => ({ ...current, enabled }));
            if (!enabled) clearQueryImproverError();
          }}
          onImproveQuery={createImprovedQuery}
          onQueryImproverSave={saveQueryImproverSettingsForSession}
          onQueryImproverReset={resetQueryImproverSettings}
          onSubmit={submit}
          onExactFrameSearch={queryByIdentifier}
          onImportCsv={importAnswerCsv}
          exactFramePending={exactFrameMutation.isPending || exactFrameResolving}
          onRrfChange={setRrfSettings}
          onRrfSave={saveRrfSettingsForSession}
          onRrfReset={resetRrfSettings}
          onRetrievalChange={setRetrievalSettings}
          onRetrievalSave={saveRetrievalSettingsForSession}
          onRetrievalReset={resetRetrievalSettings}
        />

        <div
          className={`main-workspace${selectedAnchor ? ' has-inspector' : ''}`}
          style={{ '--inspector-width': `${inspectorWidth}px` } as CSSProperties}
        >
          <FrameGrid
            frames={rankedFrames}
            selectedKey={selectedAnchor?.result_key ?? null}
            loading={searchMutation.isPending || exactFrameMutation.isPending || exactFrameResolving}
            searched={response !== null}
            skipped={normalized.skipped}
            onSelect={selectSearchFrame}
            onReorder={(from, to) => setRankedFrames((current) => reorderFrames(current, from, to))}
            onMoveToTop={(frame) => moveFrameToEdge(frame, 'top')}
            onMoveToBottom={(frame) => moveFrameToEdge(frame, 'bottom')}
            onQueryFrame={queryByFrame}
            onExportTrakeCsv={task === 'trake' ? exportRankedTrakeCsv : undefined}
            trakeFrameSelections={task === 'trake' ? trakeFrameSelections : undefined}
            queueKeys={task === 'qa' ? vqaQueueKeys : undefined}
            queueCount={task === 'qa' ? vqaQueue.length : task === 'trake' ? trakeQueue.length : answers.length}
            onAddToQueue={task === 'qa' ? addFrameToVqaQueue : undefined}
            onFillQueue={task === 'qa'
              ? fillVqaAnswerQueue
              : task === 'trake'
                ? fillTrakeAnswerQueue
                : fillTextualKisQueue}
            queueLabel={task === 'trake'
              ? `Lấy top 100 retrieval frame vào hàng đợi (${trakeQueue.length}/100)`
              : `Lấy top 100 frame vào hàng đợi (${task === 'qa' ? vqaQueue.length : answers.length}/100)`}
            batchTopK={task === 'qa' ? batchTopK : undefined}
            onBatchTopKChange={task === 'qa' ? setBatchTopK : undefined}
            onRunBatchVqa={task === 'qa' ? runBatchVqa : undefined}
            onStopBatchVqa={task === 'qa' ? stopBatchVqa : undefined}
            batchVqaLoading={task === 'qa' ? batchVqaLoading : false}
            batchVqaProgress={task === 'qa' ? batchVqaProgress : null}
          />
          {selectedAnchor && activeFrame && (
            <FrameInspector
              task={task}
              anchor={selectedAnchor}
              active={activeFrame}
              inspectorWidth={inspectorWidth}
              events={events}
              assignedFrames={assignedFrames}
              qaAnswer={qaAnswer}
              onClose={() => {
                setSelectedAnchor(null);
                setActiveFrame(null);
                setStudioOpen(false);
              }}
              onOpenStudio={openStudio}
              onInspectorWidthChange={resizeInspector}
              onQaAnswerChange={setQaAnswer}
              onSuggestVqaAnswer={task === 'qa' ? suggestAnswer : undefined}
              vqaAnswerLoading={vqaAnswerMutation.isPending || batchVqaLoading}
              onAddAnswer={addCurrentAnswer}
              onSelectAssignedFrame={selectAssignedFrame}
              onAutoSelectNearbyFrames={task === 'trake' ? autoSelectNearbyTrakeFramesForAnchor : undefined}
            />
          )}
        </div>
      </div>

      {studioOpen && studioVideoId && studioQuery.isPending && (
        <div className="video-studio-backdrop">
          <div className="video-studio-status" role="dialog" aria-modal="true" aria-label={`Video studio ${studioVideoId}`}>
            <span className="loading-spinner" aria-hidden="true" />
            <p>Đang tải video studio…</p>
            <button type="button" className="secondary-button" onClick={() => setStudioOpen(false)}>Đóng</button>
          </div>
        </div>
      )}

      {studioOpen && studioVideoId && studioQuery.error && !studioQuery.data && (
        <div className="video-studio-backdrop">
          <div className="video-studio-status" role="dialog" aria-modal="true" aria-label={`Video studio ${studioVideoId}`}>
            <p className="inline-error">{readError(studioQuery.error, 'Không thể tải video studio.')}</p>
            <button type="button" className="secondary-button" onClick={() => setStudioOpen(false)}>Đóng</button>
          </div>
        </div>
      )}

      {studioOpen && studioQuery.data && activeFrame && (
        <VideoStudioModal
          studio={studioQuery.data}
          initialFrameId={activeFrame.video_id === studioQuery.data.video.video_id
            ? activeFrame.original_frame_id
            : studioQuery.data.frames[0]?.original_frame_id ?? 0}
          initialTimestampMs={activeFrame.timestamp_ms}
          onClose={() => setStudioOpen(false)}
          onSelectFrame={selectStudioFrame}
          onSelectFrames={selectStudioFrames}
          selectionMode={task === 'trake' ? 'multiple' : 'single'}
          initialSelectedFrameIds={task === 'trake'
            ? assignedFrames.flatMap((frame) => frame ? [frame.original_frame_id] : [])
            : []}
          loadExactFrame={exactFrameLoader}
        />
      )}

      <div className="toast-stack" aria-live="polite">
        {error && <p role="alert" className="toast error">{error}</p>}
        {notice && <p role="status" className="toast success">{notice}</p>}
      </div>

      <HistoryPanel
        open={historyOpen}
        entries={historyEntries}
        onClose={() => setHistoryOpen(false)}
        onRestore={restoreHistoryEntry}
        onRemove={removeHistoryEntry}
        onClear={clearHistory}
      />

      <AnswerDrawer
        open={drawerOpen}
        task={task}
        queryId={response?.query_id ?? 'draft-query'}
        answers={task === 'qa' ? vqaAnswers : task === 'trake' ? trakeAnswers : answers}
        saveSelection={saveSelection}
        createPreview={createPreview}
        onClose={() => setDrawerOpen(false)}
        onRemove={removeAnswer}
        onMove={moveAnswer}
        vqaQueue={task === 'qa' ? vqaQueue : undefined}
        onRemoveVqaQueueItem={task === 'qa' ? removeVqaQueueItem : undefined}
        onMoveVqaQueueItem={task === 'qa' ? moveVqaQueueItem : undefined}
        onApplyAnswerToPending={task === 'qa' ? applyAnswerToAllPending : undefined}
        trakeQueue={task === 'trake' ? trakeQueue : undefined}
        onRemoveTrakeQueueItem={task === 'trake' ? (key) => setTrakeQueue((current) => removeTrakeQueueItem(current, key)) : undefined}
        onMoveTrakeQueueItem={task === 'trake' ? (from, to) => setTrakeQueue((current) => moveTrakeQueueItem(current, from, to)) : undefined}
        onCompleteMissingTrakeQueue={task === 'trake' ? completeMissingTrakeQueue : undefined}
        trakeQueueLoading={task === 'trake' ? trakeQueueLoading : false}
      />
    </main>
  );
}

function readError(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, '_').slice(0, 80) || 'query';
}
