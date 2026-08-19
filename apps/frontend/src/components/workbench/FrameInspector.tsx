'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  FrameCandidate,
  QualificationEventInput,
  QualificationTask,
  SearchEvidence,
} from '../../lib/contracts';
import { displayMatchedModalities, formatMs, groupEvidence } from '../../lib/workbench-model';

export const DEFAULT_INSPECTOR_WIDTH = 410;
export const MIN_INSPECTOR_WIDTH = 300;
export const MAX_INSPECTOR_WIDTH = 640;
const INSPECTOR_RESIZE_STEP = 20;

interface Props {
  task: QualificationTask;
  anchor: FrameCandidate;
  active: FrameCandidate;
  inspectorWidth: number;
  events: readonly QualificationEventInput[];
  assignedFrames: readonly (FrameCandidate | null)[];
  qaAnswer: string;
  onClose: () => void;
  onOpenStudio: () => void;
  onInspectorWidthChange: (width: number) => void;
  onQaAnswerChange: (value: string) => void;
  onSuggestVqaAnswer?: () => void;
  vqaAnswerLoading?: boolean;
  onAddAnswer: () => void;
  onAssignEvent: (index: number) => void;
}

const EVIDENCE_LABELS: ReadonlyArray<{
  key: 'ocr' | 'asr' | 'caption' | 'object' | 'other';
  label: string;
}> = [
  { key: 'ocr', label: 'Văn bản trong hình (OCR)' },
  { key: 'asr', label: 'Lời thoại (ASR)' },
  { key: 'caption', label: 'Mô tả cảnh' },
  { key: 'object', label: 'Object detection' },
  { key: 'other', label: 'Bằng chứng khác' },
];

export function FrameInspector({
  task,
  anchor,
  active,
  inspectorWidth,
  events,
  assignedFrames,
  qaAnswer,
  onClose,
  onOpenStudio,
  onInspectorWidthChange,
  onQaAnswerChange,
  onSuggestVqaAnswer,
  vqaAnswerLoading = false,
  onAddAnswer,
  onAssignEvent,
}: Props) {
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ clientX: number; width: number } | null>(null);
  const evidence = useMemo(
    () => groupEvidence(active.evidence, active.timestamp_ms),
    [active.evidence, active.timestamp_ms],
  );
  const modalityLabel = displayMatchedModalities(active.matched_modalities);

  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStartRef.current = { clientX: event.clientX, width: inspectorWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  }

  function updateResize(event: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (!start) return;
    onInspectorWidthChange(start.width + start.clientX - event.clientX);
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeStartRef.current = null;
    setIsResizing(false);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const nextWidth = event.key === 'ArrowLeft'
      ? inspectorWidth + INSPECTOR_RESIZE_STEP
      : event.key === 'ArrowRight'
        ? inspectorWidth - INSPECTOR_RESIZE_STEP
        : event.key === 'Home'
          ? MIN_INSPECTOR_WIDTH
          : event.key === 'End'
            ? MAX_INSPECTOR_WIDTH
            : null;
    if (nextWidth === null) return;
    event.preventDefault();
    onInspectorWidthChange(nextWidth);
  }

  return (
    <aside className={`frame-inspector${isResizing ? ' is-resizing' : ''}`} aria-label="Chi tiết frame">
      <div
        className="inspector-resize-handle"
        role="separator"
        aria-label="Điều chỉnh chiều rộng panel video"
        aria-orientation="vertical"
        aria-valuemin={MIN_INSPECTOR_WIDTH}
        aria-valuemax={MAX_INSPECTOR_WIDTH}
        aria-valuenow={inspectorWidth}
        tabIndex={0}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={beginResize}
        onPointerMove={updateResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onLostPointerCapture={() => {
          resizeStartRef.current = null;
          setIsResizing(false);
        }}
      />
      <header className="inspector-heading">
        <div>
          <p>{active.video_id}</p>
          <h2>Frame {active.original_frame_id}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Đóng chi tiết frame" onClick={onClose}>×</button>
      </header>

      <div className="inspector-media">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={active.thumbnail_uri} alt={`Frame ${active.original_frame_id} của ${active.video_id}`} />
      </div>

      <div className="inspector-meta">
        <span>{formatMs(active.timestamp_ms)}</span>
        <span>Điểm {active.score.toFixed(3)}</span>
        <span>{modalityLabel || '—'}</span>
      </div>

      <div className="media-actions">
        <button type="button" className="secondary-button" onClick={onOpenStudio}>
          Xem video studio
        </button>
      </div>

      <section className="answer-builder">
        <h3>{task === 'trake' ? 'Gán chuỗi sự kiện' : 'Tạo đáp án'}</h3>
        {task === 'qa' && (
          <label className="input-field compact-field">
            <span>Câu trả lời</span>
            <input
              aria-label="Câu trả lời"
              value={qaAnswer}
              maxLength={2000}
              placeholder="Nhập câu trả lời ngắn gọn…"
              onChange={(event) => onQaAnswerChange(event.target.value)}
            />
          </label>
        )}
        {task === 'qa' ? (
          <div className="answer-builder-actions">
            <button
              type="button"
              className="secondary-button full-width"
              disabled={!onSuggestVqaAnswer || vqaAnswerLoading}
              onClick={() => onSuggestVqaAnswer?.()}
            >
              {vqaAnswerLoading ? 'Đang hỏi LLM…' : 'Gợi ý answer bằng LLM'}
            </button>
            <button type="button" className="primary-button full-width" onClick={onAddAnswer}>
              Thêm vào đáp án
            </button>
          </div>
        ) : task === 'trake' ? (
          <div className="event-assignments">
            {events.map((event, index) => (
              <div key={event.event_id}>
                <span><b>{index + 1}</b>{event.description}</span>
                <button type="button" onClick={() => onAssignEvent(index)}>
                  {assignedFrames[index] ? `Frame ${assignedFrames[index]?.original_frame_id}` : 'Gán frame hiện tại'}
                </button>
              </div>
            ))}
            <button type="button" className="primary-button full-width" onClick={onAddAnswer}>
              Thêm chuỗi vào đáp án
            </button>
          </div>
        ) : (
          <button type="button" className="primary-button full-width" onClick={onAddAnswer}>
            Thêm vào đáp án
          </button>
        )}
      </section>

      <section className="evidence-panel">
        <h3>Bằng chứng liên quan</h3>
        {EVIDENCE_LABELS.map(({ key, label }) => (
          evidence[key].length > 0 && <EvidenceBlock key={key} label={label} items={evidence[key]} />
        ))}
        {active.evidence.length === 0 && <p className="muted-copy">Frame này chưa có bằng chứng văn bản đi kèm.</p>}
      </section>
    </aside>
  );
}

function EvidenceBlock({ label, items }: { label: string; items: readonly SearchEvidence[] }) {
  return (
    <div className="evidence-block">
      <h4>{label}</h4>
      {items.map((item) => (
        <article key={item.evidence_id}>
          <p>{item.snippet || 'Không có nội dung trích xuất.'}</p>
          <small>{item.producer}</small>
        </article>
      ))}
    </div>
  );
}
