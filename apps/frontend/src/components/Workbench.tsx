'use client';

import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import type {
  FrameCandidate,
  QaAnswer,
  QualificationAnswer,
  QualificationEventInput,
  QualificationTask,
  SearchRequest,
  SearchResponse,
  SelectionRevision,
  SubmissionPreview,
  TextualKisAnswer,
  TrakeAnswer,
  VqaAnswerRequest,
  VqaAnswerSuggestion,
  VideoFrame,
  VideoFramesResponse,
  VideoPlayback,
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
  buildSearchEmbeddingConfig,
  DEFAULT_EMBEDDING_SETTINGS,
  loadEmbeddingSettings,
  saveEmbeddingSettings,
  validateEmbeddingSettings,
  type EmbeddingSettings,
} from '../lib/embedding-settings';
import { toFrameCandidates, validateTrakeSequence } from '../lib/workbench-model';
import { useWorkbenchStore } from '../lib/workbench-store';
import { AnswerDrawer } from './workbench/AnswerDrawer';
import { FrameGrid } from './workbench/FrameGrid';
import { FrameInspector } from './workbench/FrameInspector';
import { LlmSettingsPopover } from './workbench/LlmSettingsPopover';
import { SearchSidebar } from './workbench/SearchSidebar';

interface Props {
  search: (request: SearchRequest) => Promise<SearchResponse>;
  loadPlayback: (videoId: string, frameId: number) => Promise<VideoPlayback>;
  loadFrames: (videoId: string, centerFrameId: number, limit: number) => Promise<VideoFramesResponse>;
  saveSelection: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SelectionRevision>;
  createPreview: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SubmissionPreview>;
  suggestVqaAnswer: (request: VqaAnswerRequest) => Promise<VqaAnswerSuggestion>;
}

function initialEvents(): QualificationEventInput[] {
  return [{ event_id: 'event-1', event_ordinal: 1, description: '' }];
}

export function Workbench({ search, loadPlayback, loadFrames, saveSelection, createPreview, suggestVqaAnswer }: Props) {
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
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<FrameCandidate | null>(null);
  const [activeFrame, setActiveFrame] = useState<FrameCandidate | null>(null);
  const [assignedFrames, setAssignedFrames] = useState<Array<FrameCandidate | null>>([null]);
  const [qaAnswer, setQaAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [llmSettings, setLlmSettings] = useState<LlmSettings>(DEFAULT_LLM_SETTINGS);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [embeddingSettings, setEmbeddingSettings] = useState<EmbeddingSettings>(DEFAULT_EMBEDDING_SETTINGS);
  const [embeddingError, setEmbeddingError] = useState<string | null>(null);

  const searchMutation = useMutation({
    mutationFn: (request: SearchRequest) => search(request),
  });
  const vqaAnswerMutation = useMutation({
    mutationFn: (request: VqaAnswerRequest) => suggestVqaAnswer(request),
  });
  const normalized = useMemo(
    () => response ? toFrameCandidates(response) : { frames: [], skipped: 0 },
    [response],
  );

  useEffect(() => () => reset(), [reset]);

  useEffect(() => {
    setLlmSettings(loadLlmSettings());
    setEmbeddingSettings(loadEmbeddingSettings());
  }, []);

  function changeTask(nextTask: QualificationTask) {
    setTask(nextTask);
    setDescription('');
    setQuestion('');
    setEvents(initialEvents());
    setAssignedFrames([null]);
    setResponse(null);
    setSelectedAnchor(null);
    setActiveFrame(null);
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

    const query = task === 'trake'
      ? eventDescriptions.map((item, index) => `${index + 1}. ${item}`).join('\n')
      : task === 'qa'
        ? `${cleanDescription}\nCâu hỏi: ${cleanQuestion}`
        : cleanDescription;
    const backendTask = task === 'qa' ? 'vqa' : task;

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
    try {
      const embedding = buildSearchEmbeddingConfig(embeddingSettings);
      const next = await searchMutation.mutateAsync({
        query,
        task: backendTask,
        top_k: 20,
        ...(embedding ? { embedding } : {}),
      });
      setResponse(next);
    } catch (reason) {
      setError(readError(reason, 'Tìm kiếm thất bại.'));
    }
  }

  function selectSearchFrame(frame: FrameCandidate) {
    setSelectedAnchor(frame);
    setActiveFrame(frame);
    setQaAnswer('');
    setError(null);
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
      const suggestion = await vqaAnswerMutation.mutateAsync({
        query_id: response.query_id,
        question: question.trim(),
        video_id: activeFrame.video_id,
        original_frame_id: activeFrame.original_frame_id,
        ...(llm ? { llm } : {}),
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
              setEmbeddingError(null);
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
          description={description}
          question={question}
          events={events}
          pending={searchMutation.isPending}
          onTaskChange={changeTask}
          onDescriptionChange={setDescription}
          onQuestionChange={setQuestion}
          onEventChange={(eventId, value) => setEvents((current) => current.map((item) => (
            item.event_id === eventId ? { ...item, description: value } : item
          )))}
          onAddEvent={addEvent}
          onRemoveEvent={removeEvent}
          onSubmit={submit}
        />

        <div className={`main-workspace${selectedAnchor ? ' has-inspector' : ''}`}>
          <FrameGrid
            frames={normalized.frames}
            selectedKey={selectedAnchor?.result_key ?? null}
            loading={searchMutation.isPending}
            searched={response !== null}
            skipped={normalized.skipped}
            onSelect={selectSearchFrame}
          />
          {selectedAnchor && activeFrame && (
            <FrameInspector
              task={task}
              anchor={selectedAnchor}
              active={activeFrame}
              events={events}
              assignedFrames={assignedFrames}
              qaAnswer={qaAnswer}
              loadPlayback={loadPlayback}
              loadFrames={loadFrames}
              onClose={() => {
                setSelectedAnchor(null);
                setActiveFrame(null);
              }}
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
