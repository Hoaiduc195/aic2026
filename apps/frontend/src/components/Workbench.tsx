'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useEffect, useMemo, useState } from 'react';

import type {
  FrameCandidate,
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
  VideoFrame,
  VideoFramesResponse,
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
import { activeAsrSpans, frameThumbnailUri } from '../lib/video-studio-model';
import {
  buildRankedTextualSubmission,
  reorderFrames,
  toFrameCandidates,
  validateTrakeSequence,
} from '../lib/workbench-model';
import { useWorkbenchStore } from '../lib/workbench-store';
import { AnswerDrawer } from './workbench/AnswerDrawer';
import { FrameGrid } from './workbench/FrameGrid';
import {
  DEFAULT_INSPECTOR_WIDTH,
  FrameInspector,
  MAX_INSPECTOR_WIDTH,
  MIN_INSPECTOR_WIDTH,
} from './workbench/FrameInspector';
import { LlmSettingsPopover } from './workbench/LlmSettingsPopover';
import { SearchSidebar } from './workbench/SearchSidebar';
import { VideoStudioModal } from './workbench/VideoStudioModal';

interface Props {
  search: (request: SearchRequest) => Promise<SearchResponse>;
  loadFrames: (videoId: string, centerFrameId: number, limit: number) => Promise<VideoFramesResponse>;
  loadStudio: (videoId: string, signal?: AbortSignal) => Promise<VideoStudioResponse>;
  saveSelection: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SelectionRevision>;
  createPreview: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SubmissionPreview>;
  suggestVqaAnswer: (request: VqaAnswerRequest) => Promise<VqaAnswerSuggestion>;
  improveQuery: (request: QueryImprovementRequest) => Promise<QueryImprovementResponse>;
}

function initialEvents(): QualificationEventInput[] {
  return [{ event_id: 'event-1', event_ordinal: 1, description: '' }];
}

function buildWorkbenchQuery(
  task: QualificationTask,
  description: string,
  question: string,
  events: readonly QualificationEventInput[],
): { query: string; backendTask: QueryImprovementRequest['task'] } {
  const eventDescriptions = events.map((item) => item.description.trim());
  const cleanDescription = description.trim();
  const cleanQuestion = question.trim();
  return {
    query: task === 'trake'
      ? eventDescriptions.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : task === 'qa'
        ? `${cleanDescription}\nCâu hỏi: ${cleanQuestion}`
        : cleanDescription,
    backendTask: task === 'qa' ? 'vqa' : task,
  };
}

export function Workbench({ search, loadFrames, loadStudio, saveSelection, createPreview, suggestVqaAnswer, improveQuery }: Props) {
  const task = useWorkbenchStore((state) => state.task);
  const answers = useWorkbenchStore((state) => state.answers);
  const setTask = useWorkbenchStore((state) => state.setTask);
  const addAnswer = useWorkbenchStore((state) => state.addAnswer);
  const removeAnswer = useWorkbenchStore((state) => state.removeAnswer);
  const moveAnswer = useWorkbenchStore((state) => state.moveAnswer);
  const reset = useWorkbenchStore((state) => state.reset);

  const [description, setDescription] = useState('');
  const [question, setQuestion] = useState('');
  const [events, setEvents] = useState<QualificationEventInput[]>(initialEvents);
  const [queryImproverSettings, setQueryImproverSettings] = useState<QueryImproverSettings>({ enabled: false });
  const [improvedQuery, setImprovedQuery] = useState('');
  const [queryImproverError, setQueryImproverError] = useState<string | null>(null);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [rankedFrames, setRankedFrames] = useState<FrameCandidate[]>([]);
  const [selectedAnchor, setSelectedAnchor] = useState<FrameCandidate | null>(null);
  const [activeFrame, setActiveFrame] = useState<FrameCandidate | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(DEFAULT_INSPECTOR_WIDTH);
  const [assignedFrames, setAssignedFrames] = useState<Array<FrameCandidate | null>>([null]);
  const [qaAnswer, setQaAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  const searchMutation = useMutation({
    mutationFn: (request: SearchRequest) => search(request),
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
  const normalized = useMemo(
    () => response ? toFrameCandidates(response) : { frames: [], skipped: 0 },
    [response],
  );

  useEffect(() => {
    setRankedFrames(normalized.frames);
  }, [normalized.frames]);

  useEffect(() => () => reset(), [reset]);

  useEffect(() => {
    setLlmSettings(loadLlmSettings());
    setVlmSettings(loadVlmSettings());
    setEmbeddingSettings(loadEmbeddingSettings());
    setRetrievalSettings(loadRetrievalSettings());
    setRrfSettings(loadRrfSettings());
    setQueryImproverSettings(loadQueryImproverSettings());
  }, []);

  function invalidateImprovedQuery() {
    setImprovedQuery('');
    setQueryImproverError(null);
  }

  function changeTask(nextTask: QualificationTask) {
    setTask(nextTask);
    setDescription('');
    setQuestion('');
    setEvents(initialEvents());
    invalidateImprovedQuery();
    setAssignedFrames([null]);
    setResponse(null);
    setSelectedAnchor(null);
    setActiveFrame(null);
    setStudioOpen(false);
    setStudioVideoId(null);
    setError(null);
    setNotice(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const eventDescriptions = events.map((item) => item.description.trim()).filter(Boolean);
    const cleanDescription = description.trim();
    const cleanQuestion = question.trim();
    if (searchMutation.isPending) return;
    if (task === 'trake' ? eventDescriptions.length !== events.length : !cleanDescription) return;
    if (task === 'qa' && !cleanQuestion) return;

    const { query, backendTask } = buildWorkbenchQuery(task, description, question, events);
    const retrievalQuery = queryImproverSettings.enabled && improvedQuery.trim()
      ? improvedQuery.trim()
      : query;

    setError(null);
    setNotice(null);
    setResponse(null);
    setSelectedAnchor(null);
    setActiveFrame(null);
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
        query: retrievalQuery,
        task: backendTask,
        top_k: retrieval.display_k,
        retrieval,
        ...(embedding ? { embedding } : {}),
      });
      setResponse(next);
      if (queryImproverSettings.enabled && !improvedQuery.trim()) {
        setNotice('Chưa có preview query tiếng Anh; hệ thống tìm bằng query gốc.');
      }
    } catch (reason) {
      setError(readError(reason, 'Tìm kiếm thất bại.'));
    }
  }

  async function createImprovedQuery() {
    const eventDescriptions = events.map((item) => item.description.trim());
    const cleanDescription = description.trim();
    const cleanQuestion = question.trim();
    if (task === 'trake' ? eventDescriptions.length !== events.length : !cleanDescription) return;
    if (task === 'qa' && !cleanQuestion) return;

    const { query, backendTask } = buildWorkbenchQuery(task, description, question, events);
    setQueryImproverError(null);
    setNotice(null);
    try {
      const frontendLlm = llmSettings.enabled && validateLlmSettings(llmSettings) === null
        ? buildVqaLlmConfig(llmSettings)
        : undefined;
      const result = await queryImproverMutation.mutateAsync({
        query,
        task: backendTask,
        ...(frontendLlm ? { llm: frontendLlm } : {}),
      });
      setImprovedQuery(result.improved_query);
      setNotice(result.warning
        ? 'Không dùng được Query Improver; preview đang giữ query gốc.'
        : 'Đã tạo query tiếng Anh. Bạn có thể chỉnh sửa trước khi tìm.');
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
    invalidateImprovedQuery();
    setNotice('Đã tắt Query Improver.');
  }

  function selectSearchFrame(frame: FrameCandidate) {
    setSelectedAnchor(frame);
    setActiveFrame(frame);
    setQaAnswer('');
    setError(null);
  }

  function exportRankedTextualFrames() {
    if (task !== 'textual_kis' || !response?.query_id || rankedFrames.length === 0) return;
    const payload = buildRankedTextualSubmission(response.query_id, rankedFrames);
    if (!payload) return;

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aic-${safeFilenamePart(response.query_id)}-textual_kis.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setNotice(`Đã export ${payload.answers.length} kết quả theo thứ tự hiện tại.`);
  }

  function selectNeighborFrame(frame: VideoFrame) {
    if (!selectedAnchor) return;
    setActiveFrame({
      ...selectedAnchor,
      original_frame_id: frame.original_frame_id,
      timestamp_ms: frame.timestamp_ms,
      thumbnail_uri: frame.thumbnail_uri,
      evidence: frame.evidence ? [...frame.evidence] : [...selectedAnchor.evidence],
    });
  }

  function openStudio() {
    if (!activeFrame) return;
    setStudioVideoId(activeFrame.video_id);
    setStudioOpen(true);
  }

  function selectStudioFrame(frame: StudioFrame) {
    if (!selectedAnchor || !studioQuery.data) return;
    const asrEvidence = activeAsrSpans(studioQuery.data.asr_spans, frame.timestamp_ms).map((span) => ({
      evidence_id: span.evidence_id,
      type: 'asr' as const,
      snippet: span.text,
      producer: span.producer,
      start_ms: span.start_ms,
      end_ms: span.end_ms,
    }));
    setActiveFrame({
      ...selectedAnchor,
      original_frame_id: frame.original_frame_id,
      timestamp_ms: frame.timestamp_ms,
      thumbnail_uri: frameThumbnailUri(frame.video_id, frame.original_frame_id),
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
    });
    setNotice(`Đã chọn frame ${frame.original_frame_id} làm bằng chứng hiện tại.`);
  }

  function resizeInspector(width: number) {
    const boundedWidth = Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, Math.round(width)));
    setInspectorWidth(boundedWidth);
  }

  function addCurrentAnswer() {
    if (!activeFrame) return;
    if (answers.length >= 100) {
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
      addAnswer({
        video_id: activeFrame.video_id,
        frame_id: activeFrame.original_frame_id,
        answer: qaAnswer.trim(),
      } satisfies QaAnswer);
      setQaAnswer('');
    } else {
      const sequence = assignedFrames.filter((frame): frame is FrameCandidate => frame !== null);
      if (sequence.length !== events.length || !validateTrakeSequence(sequence)) {
        setError('TRAKE cần đủ frame, cùng video và tăng dần theo thời gian.');
        return;
      }
      addAnswer({
        video_id: sequence[0].video_id,
        frame_ids: sequence.map((frame) => frame.original_frame_id),
      } satisfies TrakeAnswer);
      setAssignedFrames(events.map(() => null));
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

  function addEvent() {
    setEvents((current) => {
      const nextOrdinal = current.length + 1;
      return [...current, { event_id: `event-${Date.now()}-${nextOrdinal}`, event_ordinal: nextOrdinal, description: '' }];
    });
    setAssignedFrames((current) => [...current, null]);
  }

  function removeEvent(eventId: string) {
    setEvents((current) => current
      .filter((item) => item.event_id !== eventId)
      .map((item, index) => ({ ...item, event_ordinal: index + 1 })));
    const index = events.findIndex((item) => item.event_id === eventId);
    setAssignedFrames((current) => current.filter((_, frameIndex) => frameIndex !== index));
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
              setSettingsOpen((open) => !open);
            }}
          >
            Cài đặt
          </button>
          <button type="button" className="answer-badge" onClick={() => setDrawerOpen(true)}>Đáp án ({answers.length})</button>
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
          pending={searchMutation.isPending}
          onTaskChange={changeTask}
          onDescriptionChange={(value) => { setDescription(value); invalidateImprovedQuery(); }}
          onQuestionChange={(value) => { setQuestion(value); invalidateImprovedQuery(); }}
          onEventChange={(eventId, value) => {
            setEvents((current) => current.map((item) => (
              item.event_id === eventId ? { ...item, description: value } : item
            )));
            invalidateImprovedQuery();
          }}
          onAddEvent={() => { addEvent(); invalidateImprovedQuery(); }}
          onRemoveEvent={(eventId) => { removeEvent(eventId); invalidateImprovedQuery(); }}
          queryImproverEnabled={queryImproverSettings.enabled}
          improvedQuery={improvedQuery}
          queryImproverPending={queryImproverMutation.isPending}
          queryImproverError={queryImproverError}
          onQueryImproverChange={(enabled) => {
            setQueryImproverSettings((current) => ({ ...current, enabled }));
            if (!enabled) invalidateImprovedQuery();
          }}
          onImprovedQueryChange={setImprovedQuery}
          onImproveQuery={createImprovedQuery}
          onQueryImproverSave={saveQueryImproverSettingsForSession}
          onQueryImproverReset={resetQueryImproverSettings}
          onSubmit={submit}
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
            loading={searchMutation.isPending}
            searched={response !== null}
            skipped={normalized.skipped}
            onSelect={selectSearchFrame}
            onReorder={(from, to) => setRankedFrames((current) => reorderFrames(current, from, to))}
            onExport={task === 'textual_kis' ? exportRankedTextualFrames : undefined}
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
              loadFrames={loadFrames}
              onClose={() => {
                setSelectedAnchor(null);
                setActiveFrame(null);
                setStudioOpen(false);
              }}
              onOpenStudio={openStudio}
              onInspectorWidthChange={resizeInspector}
              onFrameSelect={selectNeighborFrame}
              onQaAnswerChange={setQaAnswer}
              onSuggestVqaAnswer={task === 'qa' ? suggestAnswer : undefined}
              vqaAnswerLoading={vqaAnswerMutation.isPending}
              onAddAnswer={addCurrentAnswer}
              onAssignEvent={(index) => setAssignedFrames((current) => current.map((frame, frameIndex) => (
                frameIndex === index ? activeFrame : frame
              )))}
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
        />
      )}

      <div className="toast-stack" aria-live="polite">
        {error && <p role="alert" className="toast error">{error}</p>}
        {notice && <p role="status" className="toast success">{notice}</p>}
      </div>

      <AnswerDrawer
        open={drawerOpen}
        task={task}
        queryId={response?.query_id ?? 'draft-query'}
        answers={answers}
        saveSelection={saveSelection}
        createPreview={createPreview}
        onClose={() => setDrawerOpen(false)}
        onRemove={removeAnswer}
        onMove={moveAnswer}
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
