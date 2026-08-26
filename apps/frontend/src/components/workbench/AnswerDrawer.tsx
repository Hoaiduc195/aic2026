'use client';

import { type PointerEvent, useEffect, useRef, useState } from 'react';

import type {
  QualificationAnswer,
  QualificationTask,
  SelectionRevision,
  SubmissionPreview,
} from '../../lib/contracts';
import { buildSubmissionCsv } from '../../lib/submission-csv';
import { buildSubmission } from '../../lib/workbench-model';
import { frameThumbnailUri } from '../../lib/video-studio-model';
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
  onClearQueue?: () => void;
  vqaQueue?: readonly VqaQueueItem[];
  onRemoveVqaQueueItem?: (key: string) => void;
  onMoveVqaQueueItem?: (from: number, to: number) => void;
  onUpdateVqaQueueAnswer?: (key: string, answer: string) => void;
  onApplyAnswerToPending?: (answer: string) => void;
  trakeQueue?: readonly TrakeQueueItem[];
  onRemoveTrakeQueueItem?: (key: string) => void;
  onMoveTrakeQueueItem?: (from: number, to: number) => void;
  onCompleteMissingTrakeQueue?: () => void;
  trakeQueueLoading?: boolean;
  trakeExpectedFrameCount?: number;
}

interface PendingDrag {
  pointerId: number;
  sourceIndex: number;
  startY: number;
  started: boolean;
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
  onClearQueue,
  vqaQueue = [],
  onRemoveVqaQueueItem,
  onMoveVqaQueueItem,
  onUpdateVqaQueueAnswer,
  onApplyAnswerToPending,
  trakeQueue = [],
  onRemoveTrakeQueueItem,
  onMoveTrakeQueueItem,
  onCompleteMissingTrakeQueue,
  trakeQueueLoading = false,
  trakeExpectedFrameCount,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [csvExported, setCsvExported] = useState(false);
  const [customFilename, setCustomFilename] = useState('');
  const [bulkAnswer, setBulkAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [preview, setPreview] = useState<SubmissionPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const pointerDragRef = useRef<PendingDrag | null>(null);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const isVqa = task === 'qa';
  const isTrake = task === 'trake';
  const isKis = task === 'textual_kis';
  const queueCount = isVqa ? vqaQueue.length : isTrake ? trakeQueue.length : answers.length;
  const pendingCount = isVqa ? vqaQueue.filter((item) => item.status !== 'answered').length : 0;
  const missingTrakeCount = isTrake ? incompleteTrakeQueueCount(trakeQueue, trakeExpectedFrameCount) : 0;
  const completeTrakeCount = isTrake
    ? trakeQueue.filter((item) => isCompleteTrakeQueueItem(item, trakeExpectedFrameCount)).length
    : 0;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [onClose, open]);

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

  function handlePointerDown(event: PointerEvent<HTMLElement>, index: number) {
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('button, input, textarea, a')) return;

    pointerDragRef.current = {
      pointerId: event.pointerId,
      sourceIndex: index,
      startY: event.clientY,
      started: false,
    };
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>, targetIndex?: number, targetElement?: HTMLElement) {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;

    if (!pending.started) {
      const dist = Math.abs(event.clientY - pending.startY);
      if (dist < 5) return;
      pending.started = true;
      setDraggedIndex(pending.sourceIndex);
      setDropIndex(pending.sourceIndex);
    }

    if (targetIndex !== undefined) {
      setDropIndex((current) => current === targetIndex ? current : targetIndex);
      return;
    }

    const row = targetElement ?? (event.target as HTMLElement).closest<HTMLElement>('[data-answer-index]');
    if (!row) return;
    const rowIdx = Number(row.dataset.answerIndex);
    if (!Number.isFinite(rowIdx)) return;

    const bounds = row.getBoundingClientRect();
    const insertAfter = event.clientY > bounds.top + bounds.height / 2;
    const nextDropIndex = rowIdx + (insertAfter ? 1 : 0);
    setDropIndex((current) => current === nextDropIndex ? current : nextDropIndex);
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>, listLength: number, onReorder: (from: number, to: number) => void) {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;

    const sourceIndex = pending.sourceIndex;
    const targetIndex = dropIndex !== null ? (dropIndex > sourceIndex ? dropIndex - 1 : dropIndex) : sourceIndex;
    if (pending.started && sourceIndex >= 0 && targetIndex >= 0 && targetIndex < listLength && sourceIndex !== targetIndex) {
      onReorder(sourceIndex, targetIndex);
    }

    pointerDragRef.current = null;
    setDraggedIndex(null);
    setDropIndex(null);
  }

  function cancelPointerDrag() {
    pointerDragRef.current = null;
    setDraggedIndex(null);
    setDropIndex(null);
  }

  if (!open) return null;

  async function copyPayload() {
    const payload = buildSubmission(task, queryId, answers);
    if (!payload || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setActionError('Không thể sao chép JSON.');
    }
  }

  function exportPayload() {
    const payload = buildSubmission(task, queryId, answers);
    if (!payload) return;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `aic-${safeFilenamePart(queryId)}-${task}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setExported(true);
    window.setTimeout(() => setExported(false), 1500);
  }

  function exportCsv() {
    if (!answers.length) return;
    try {
      const csv = buildSubmissionCsv(task, answers);
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const userGiven = customFilename.trim();
      let baseName = userGiven || `aic-${safeFilenamePart(queryId)}-${task}`;
      if (baseName.toLowerCase().endsWith('.csv')) {
        baseName = baseName.slice(0, -4);
      }
      link.download = `${safeFilenamePart(baseName)}.csv`;
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
    if (!normalized || !onApplyAnswerToPending || pendingCount === 0) return;
    onApplyAnswerToPending(normalized);
    setBulkAnswer('');
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
          <div className="drawer-header-actions">
            {onClearQueue && queueCount > 0 && (
              <button
                type="button"
                className="quiet-button clear-queue-button"
                aria-label="Xóa tất cả"
                onClick={onClearQueue}
              >
                Xóa tất cả
              </button>
            )}
            <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Đóng" onClick={onClose}>×</button>
          </div>
          <div className="drawer-status-stack" aria-live="polite">
            {actionError && <p role="alert" className="drawer-error">{actionError}</p>}
            {isVqa && pendingCount > 0 && (
              <p role="status" className="drawer-warning">
                ⚠️ Còn {pendingCount} frame chưa có câu trả lời (pending).
              </p>
            )}
            {revision !== null && <p role="status" className="drawer-status">Đã lưu revision {revision}</p>}
            {preview && <p role="status" className="drawer-status">Preview đã tạo cho {preview.answer_count} đáp án</p>}
          </div>
        </header>

        <div
          className="answer-list"
          onPointerMove={(e) => handlePointerMove(e)}
          onPointerCancel={cancelPointerDrag}
        >
          {queueCount === 0 && <p className="drawer-empty">Chưa có đáp án.</p>}
          {isVqa ? vqaQueue.map((item, index) => {
            const isDragging = draggedIndex === index;
            return (
              <article
                className={`answer-row answer-row--draggable answer-row--${item.status}${isDragging ? ' answer-row--dragging' : ''}`}
                key={item.key}
                data-answer-index={index}
                onPointerDown={(e) => handlePointerDown(e, index)}
                onPointerMove={(e) => handlePointerMove(e, index, e.currentTarget)}
                onPointerUp={(e) => handlePointerUp(e, vqaQueue.length, (from, to) => onMoveVqaQueueItem?.(from, to))}
              >
                <span className="answer-drag-handle" aria-hidden="true">⠿</span>
                <span className="answer-rank">{String(index + 1).padStart(2, '0')}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frameThumbnailUri(item.video_id, item.frame_id)}
                  alt=""
                  className="answer-thumb"
                  loading="lazy"
                />
                <div className="answer-content-area">
                  <strong>{item.video_id} · frame {item.frame_id}</strong>
                  {item.answer ? (
                    <small>{item.answer}</small>
                  ) : item.status === 'error' ? (
                    <small>Lỗi: {item.error}</small>
                  ) : (
                    <small>Đang chờ answer</small>
                  )}
                  {onUpdateVqaQueueAnswer && (
                    <div className="vqa-inline-edit-group" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
                      <input
                        className="vqa-inline-answer-input"
                        aria-label={`Câu trả lời cho frame ${item.frame_id}`}
                        value={item.answer ?? ''}
                        placeholder={item.status === 'error' ? `Lỗi: ${item.error}` : 'Sửa câu trả lời…'}
                        onChange={(e) => onUpdateVqaQueueAnswer(item.key, e.target.value)}
                      />
                    </div>
                  )}
                </div>
                <div className="answer-actions">
                  <button type="button" aria-label={`Đưa frame ${item.frame_id} lên`} disabled={index === 0} onClick={() => onMoveVqaQueueItem?.(index, index - 1)}>↑</button>
                  <button type="button" aria-label={`Đưa frame ${item.frame_id} xuống`} disabled={index === vqaQueue.length - 1} onClick={() => onMoveVqaQueueItem?.(index, index + 1)}>↓</button>
                  <button type="button" aria-label={`Xóa frame ${item.frame_id}`} onClick={() => onRemoveVqaQueueItem?.(item.key)}>×</button>
                </div>
              </article>
            );
          }) : isTrake ? trakeQueue.map((item, index) => {
            const complete = isCompleteTrakeQueueItem(item);
            const frameLabel = complete
              ? item.frames.map((frame) => frame.original_frame_id).join(' → ')
              : `Chưa chọn đủ ${trakeExpectedFrameCount ?? 4} frame`;
            const isDragging = draggedIndex === index;
            return (
              <article
                className={`answer-row answer-row--draggable answer-row--${complete ? 'complete' : 'missing'}${isDragging ? ' answer-row--dragging' : ''}`}
                key={item.key}
                data-answer-index={index}
                onPointerDown={(e) => handlePointerDown(e, index)}
                onPointerMove={(e) => handlePointerMove(e, index, e.currentTarget)}
                onPointerUp={(e) => handlePointerUp(e, trakeQueue.length, (from, to) => onMoveTrakeQueueItem?.(from, to))}
              >
                <span className="answer-drag-handle" aria-hidden="true">⠿</span>
                <span className="answer-rank">{String(index + 1).padStart(2, '0')}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={frameThumbnailUri(item.anchor.video_id, item.anchor.original_frame_id)}
                  alt=""
                  className="answer-thumb"
                  loading="lazy"
                />
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
          }) : answers.map((answer, index) => {
            const isDragging = draggedIndex === index;
            const hasFrameId = 'frame_id' in answer;
            return (
              <article
                className={`answer-row answer-row--draggable${isDragging ? ' answer-row--dragging' : ''}`}
                key={`${index}-${answer.video_id}-${hasFrameId ? answer.frame_id : ''}`}
                data-answer-index={index}
                onPointerDown={(e) => handlePointerDown(e, index)}
                onPointerMove={(e) => handlePointerMove(e, index, e.currentTarget)}
                onPointerUp={(e) => handlePointerUp(e, answers.length, onMove)}
              >
                <span className="answer-drag-handle" aria-hidden="true">⠿</span>
                <span className="answer-rank">{String(index + 1).padStart(2, '0')}</span>
                {hasFrameId && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={frameThumbnailUri(answer.video_id, answer.frame_id)}
                    alt=""
                    className="answer-thumb"
                    loading="lazy"
                  />
                )}
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
            );
          })}
          {isVqa && onApplyAnswerToPending && (
            <div className="bulk-answer-panel">
              <label htmlFor="bulk-vqa-answer">Áp dụng cùng answer cho pending</label>
              <div>
                <input
                  id="bulk-vqa-answer"
                  value={bulkAnswer}
                  onChange={(event) => setBulkAnswer(event.target.value)}
                  placeholder="Nhập câu trả lời chung"
                />
                <button type="button" className="secondary-button" disabled={!bulkAnswer.trim() || pendingCount === 0} onClick={applyBulkAnswer}>
                  Áp dụng ({pendingCount})
                </button>
              </div>
            </div>
          )}
          {isTrake && onCompleteMissingTrakeQueue && missingTrakeCount > 0 && (
            <div className="bulk-answer-panel">
              <p>Đang thiếu {trakeExpectedFrameCount ?? 4} frame ở {missingTrakeCount} câu trả lời TRAKE.</p>
              <button
                type="button"
                className="secondary-button full-width"
                disabled={trakeQueueLoading}
                onClick={onCompleteMissingTrakeQueue}
              >
                {trakeQueueLoading ? 'Đang chọn frame…' : `Chọn ${trakeExpectedFrameCount ?? 4} frame cho các câu trả lời đang thiếu`}
              </button>
            </div>
          )}
        </div>

        <footer>
          <div className="drawer-csv-filename-bar">
            <label htmlFor="csv-custom-filename">Tên file CSV:</label>
            <div className="filename-input-group">
              <input
                id="csv-custom-filename"
                aria-label="Tên file CSV"
                value={customFilename}
                onChange={(e) => setCustomFilename(e.target.value)}
                placeholder={`aic-${safeFilenamePart(queryId)}-${task}`}
              />
              <span className="file-ext-badge">.csv</span>
            </div>
          </div>
          <span>{queueCount}/100 item · {isTrake ? `${completeTrakeCount} đã đủ frame` : `${answers.length} đã trả lời`}</span>
          <div className="answer-sync-actions">
            <button type="button" className="secondary-button" disabled={!answers.length || saving || previewing} onClick={saveAnswers}>
              {saving ? 'Đang lưu…' : 'Lưu đáp án'}
            </button>
            <button type="button" className="secondary-button" disabled={!answers.length || saving || previewing} onClick={createSubmissionPreview}>
              {previewing ? 'Đang tạo…' : 'Tạo preview'}
            </button>
          </div>
          {!isKis && (
            <button type="button" className="secondary-button" disabled={!answers.length} onClick={copyPayload}>
              {copied ? 'Đã sao chép' : 'Sao chép JSON'}
            </button>
          )}
          <button
            type="button"
            className={isKis ? 'primary-button' : 'secondary-button'}
            disabled={!answers.length}
            onClick={exportCsv}
          >
            {csvExported ? 'Đã export CSV' : 'Export CSV'}
          </button>
          {!isKis && (
            <button type="button" className="primary-button" disabled={!answers.length} onClick={exportPayload}>
              {exported ? 'Đã export' : 'Export JSON'}
            </button>
          )}
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
