'use client';

import { useEffect, useRef, useState } from 'react';

import type {
  QualificationAnswer,
  QualificationTask,
  SelectionRevision,
  SubmissionPreview,
} from '../../lib/contracts';
import { buildSubmissionCsv } from '../../lib/submission-csv';
import {
  incompleteTrakeQueueCount,
  isCompleteTrakeQueueItem,
  type TrakeQueueItem,
} from '../../lib/trake-queue-model';
import type { VqaQueueItem } from '../../lib/vqa-queue-model';

interface Props {
  open: boolean;
  task: QualificationTask;
  queryId: string;
  answers: readonly QualificationAnswer[];
  saveSelection: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SelectionRevision>;
  createPreview: (queryId: string, task: QualificationTask, answers: readonly QualificationAnswer[]) => Promise<SubmissionPreview>;
  onClose: () => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  vqaQueue?: readonly VqaQueueItem[];
  onRemoveVqaQueueItem?: (key: string) => void;
  onMoveVqaQueueItem?: (from: number, to: number) => void;
  onUpdateVqaAnswer?: (key: string, answer: string) => void;
  onApplyAnswerToAll?: (answer: string) => void;
  trakeQueue?: readonly TrakeQueueItem[];
  onRemoveTrakeQueueItem?: (key: string) => void;
  onMoveTrakeQueueItem?: (from: number, to: number) => void;
  onCompleteMissingTrakeQueue?: () => void;
  trakeQueueLoading?: boolean;
  trakeFrameCount?: number;
}

export function AnswerDrawer({
  open,
  task,
  queryId,
  answers,
  saveSelection,
  createPreview,
  onClose,
  onRemove,
  onMove,
  vqaQueue = [],
  onRemoveVqaQueueItem,
  onMoveVqaQueueItem,
  onUpdateVqaAnswer,
  onApplyAnswerToAll,
  trakeQueue = [],
  onRemoveTrakeQueueItem,
  onMoveTrakeQueueItem,
  onCompleteMissingTrakeQueue,
  trakeQueueLoading = false,
  trakeFrameCount = 4,
}: Props) {
  const [csvExported, setCsvExported] = useState(false);
  const [csvFilename, setCsvFilename] = useState(() => safeFilenamePart(queryId));
  const [bulkAnswer, setBulkAnswer] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [preview, setPreview] = useState<SubmissionPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const isVqa = task === 'qa';
  const isTrake = task === 'trake';
  const queueCount = isVqa ? vqaQueue.length : isTrake ? trakeQueue.length : answers.length;
  const missingTrakeCount = isTrake ? incompleteTrakeQueueCount(trakeQueue, trakeFrameCount) : 0;
  const completeTrakeCount = isTrake
    ? trakeQueue.filter((item) => isCompleteTrakeQueueItem(item, trakeFrameCount)).length
    : 0;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setCsvFilename(safeFilenamePart(queryId));
  }, [queryId]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [open]);

  function trapFocus(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const controls = drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;

  function exportCsv() {
    if (!answers.length) return;
    try {
      const csv = buildSubmissionCsv(task, answers);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeFilenamePart(csvFilename.replace(/\.csv$/i, ''))}.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setActionError(null);
      setCsvExported(true);
      window.setTimeout(() => setCsvExported(false), 1500);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Không thể export CSV.');
    }
  }

  function applyBulkAnswer() {
    const normalized = bulkAnswer.trim();
    if (!normalized || !onApplyAnswerToAll || vqaQueue.length === 0) return;
    onApplyAnswerToAll(normalized);
    setBulkAnswer('');
  }

  function dropQueueItem(to: number, move?: (from: number, to: number) => void) {
    if (draggedIndex === null) return;
    move?.(draggedIndex, to);
    setDraggedIndex(null);
  }

  async function saveAnswers() {
    if (!answers.length || saving || previewing) return;
    setSaving(true);
    setActionError(null);
    try {
      const result = await saveSelection(queryId, task, answers);
      setRevision(result.revision);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Không thể lưu đáp án.');
    } finally {
      setSaving(false);
    }
  }

  async function createSubmissionPreview() {
    if (!answers.length || saving || previewing) return;
    setPreviewing(true);
    setActionError(null);
    try {
      setPreview(await createPreview(queryId, task, answers));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Không thể tạo preview.');
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <>
      <button type="button" className="drawer-backdrop" aria-label="Đóng hàng đợi đáp án" onClick={onClose} />
      <aside ref={drawerRef} className="answer-drawer" role="dialog" aria-modal="true" aria-label="Hàng đợi đáp án" onKeyDown={trapFocus}>
        <header>
          <div>
            <p className="section-kicker">Bản nháp và đồng bộ backend</p>
            <h2>Hàng đợi đáp án</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Đóng" onClick={onClose}>×</button>
          <div className="drawer-status-stack" aria-live="polite">
            {actionError && <p role="alert" className="drawer-error">{actionError}</p>}
            {revision !== null && <p role="status" className="drawer-status">Đã lưu revision {revision}</p>}
            {preview && <p role="status" className="drawer-status">Preview đã tạo cho {preview.answer_count} đáp án</p>}
          </div>
        </header>

        <div className="answer-list">
          {queueCount === 0 && <p className="drawer-empty">Chưa có đáp án.</p>}
          {isVqa ? vqaQueue.map((item, index) => (
            <article
              className={`answer-row answer-row--${item.status}${draggedIndex === index ? ' is-dragging' : ''}`}
              key={item.key}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropQueueItem(index, onMoveVqaQueueItem)}
            >
              <span
                className="answer-rank answer-drag-handle"
                draggable
                title="Kéo để đổi thứ hạng"
                onDragStart={() => setDraggedIndex(index)}
                onDragEnd={() => setDraggedIndex(null)}
              >{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{item.video_id} · frame {item.frame_id}</strong>
                <small>
                  {item.status === 'answered' || item.status === 'abstained' || item.status === 'needs_more_evidence'
                    ? item.answer ?? 'Không biết'
                    : item.status === 'error' ? `Lỗi: ${item.error}` : 'Đang chờ answer'}
                </small>
                <input
                  className="answer-edit-input"
                  aria-label={`Đáp án VQA frame ${item.frame_id}`}
                  value={item.answer ?? ''}
                  maxLength={100}
                  placeholder="Nhập hoặc chỉnh đáp án…"
                  onChange={(event) => onUpdateVqaAnswer?.(item.key, event.target.value)}
                />
              </div>
              <div className="answer-actions">
                <button type="button" aria-label={`Đưa frame ${item.frame_id} lên`} disabled={index === 0} onClick={() => onMoveVqaQueueItem?.(index, index - 1)}>↑</button>
                <button type="button" aria-label={`Đưa frame ${item.frame_id} xuống`} disabled={index === vqaQueue.length - 1} onClick={() => onMoveVqaQueueItem?.(index, index + 1)}>↓</button>
                <button type="button" aria-label={`Xóa frame ${item.frame_id}`} onClick={() => onRemoveVqaQueueItem?.(item.key)}>×</button>
              </div>
            </article>
          )) : isTrake ? trakeQueue.map((item, index) => {
            const complete = isCompleteTrakeQueueItem(item, trakeFrameCount);
            const frameLabel = complete
              ? item.frames.map((frame) => frame.original_frame_id).join(' → ')
              : `Chưa chọn đủ ${trakeFrameCount} frame`;
            return (
              <article
                className={`answer-row answer-row--${complete ? 'complete' : 'missing'}${draggedIndex === index ? ' is-dragging' : ''}`}
                key={item.key}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => dropQueueItem(index, onMoveTrakeQueueItem)}
              >
                <span
                  className="answer-rank answer-drag-handle"
                  draggable
                  title="Kéo để đổi thứ hạng"
                  onDragStart={() => setDraggedIndex(index)}
                  onDragEnd={() => setDraggedIndex(null)}
                >{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{item.anchor.video_id} · anchor frame {item.anchor.original_frame_id}</strong>
                  <small>{complete ? `Frame ${frameLabel}` : frameLabel}</small>
                </div>
                <div className="answer-actions">
                  <button type="button" aria-label={`Đưa chuỗi TRAKE ${index + 1} lên`} disabled={index === 0} onClick={() => onMoveTrakeQueueItem?.(index, index - 1)}>↑</button>
                  <button type="button" aria-label={`Đưa chuỗi TRAKE ${index + 1} xuống`} disabled={index === trakeQueue.length - 1} onClick={() => onMoveTrakeQueueItem?.(index, index + 1)}>↓</button>
                  <button type="button" aria-label={`Xóa chuỗi TRAKE ${index + 1}`} onClick={() => onRemoveTrakeQueueItem?.(item.key)}>×</button>
                </div>
              </article>
            );
          }) : answers.map((answer, index) => (
            <article
              className={`answer-row${draggedIndex === index ? ' is-dragging' : ''}`}
              key={`${index}-${answer.video_id}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => dropQueueItem(index, onMove)}
            >
              <span
                className="answer-rank answer-drag-handle"
                draggable
                title="Kéo để đổi thứ hạng"
                onDragStart={() => setDraggedIndex(index)}
                onDragEnd={() => setDraggedIndex(null)}
              >{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{answerLabel(answer)}</strong>
                {'answer' in answer && <small>{answer.answer}</small>}
              </div>
              <div className="answer-actions">
                <button type="button" aria-label={`Đưa đáp án ${index + 1} lên`} disabled={index === 0} onClick={() => onMove(index, index - 1)}>↑</button>
                <button type="button" aria-label={`Đưa đáp án ${index + 1} xuống`} disabled={index === answers.length - 1} onClick={() => onMove(index, index + 1)}>↓</button>
                <button type="button" aria-label={`Xóa đáp án ${index + 1}`} onClick={() => onRemove(index)}>×</button>
              </div>
            </article>
          ))}
          {isVqa && onApplyAnswerToAll && (
            <div className="bulk-answer-panel">
              <label htmlFor="bulk-vqa-answer">Một đáp án cho tất cả frame</label>
              <div>
                <input
                  id="bulk-vqa-answer"
                  value={bulkAnswer}
                  maxLength={100}
                  onChange={(event) => setBulkAnswer(event.target.value)}
                  placeholder="Nhập câu trả lời chung"
                />
                <button type="button" className="secondary-button" disabled={!bulkAnswer.trim() || vqaQueue.length === 0} onClick={applyBulkAnswer}>
                  Áp dụng tất cả ({vqaQueue.length})
                </button>
              </div>
            </div>
          )}
          {isTrake && onCompleteMissingTrakeQueue && missingTrakeCount > 0 && (
            <div className="bulk-answer-panel">
              <p>Đang thiếu {trakeFrameCount} frame ở {missingTrakeCount} câu trả lời TRAKE.</p>
              <button
                type="button"
                className="secondary-button full-width"
                disabled={trakeQueueLoading}
                onClick={onCompleteMissingTrakeQueue}
              >
                {trakeQueueLoading ? 'Đang chọn frame…' : `Chọn ${trakeFrameCount} frame cho các câu trả lời đang thiếu`}
              </button>
            </div>
          )}
        </div>

        <footer>
          <span>{queueCount}/100 item · {isTrake ? `${completeTrakeCount} đã đủ frame` : `${answers.length} đã trả lời`}</span>
          <div className="answer-sync-actions">
            <button type="button" className="secondary-button" disabled={!answers.length || saving || previewing} onClick={saveAnswers}>
              {saving ? 'Đang lưu…' : 'Lưu đáp án'}
            </button>
            <button type="button" className="secondary-button" disabled={!answers.length || saving || previewing} onClick={createSubmissionPreview}>
              {previewing ? 'Đang tạo…' : 'Tạo preview'}
            </button>
          </div>
          <label className="csv-filename-field">
            <span>Tên file CSV (phải khớp tên truy vấn)</span>
            <div>
              <input
                aria-label="Tên file CSV"
                value={csvFilename}
                maxLength={100}
                placeholder="query-p2-1-kis"
                onChange={(event) => setCsvFilename(event.target.value)}
              />
              <span>.csv</span>
            </div>
          </label>
          <button type="button" className="primary-button" disabled={!answers.length || !csvFilename.trim()} onClick={exportCsv}>
            {csvExported ? 'Đã export CSV' : 'Export CSV'}
          </button>
        </footer>
      </aside>
    </>
  );
}

function answerLabel(answer: QualificationAnswer): string {
  if ('frame_ids' in answer) return `${answer.video_id} · frame ${answer.frame_ids.join(' → ')}`;
  return `${answer.video_id} · frame ${answer.frame_id}`;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'query';
}
