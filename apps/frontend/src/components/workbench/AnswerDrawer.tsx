'use client';

import { useEffect, useRef, useState } from 'react';

import type {
  QualificationAnswer,
  QualificationTask,
  SelectionRevision,
  SubmissionPreview,
} from '../../lib/contracts';
import { buildSubmissionCsv } from '../../lib/submission-csv';
import { buildSubmission } from '../../lib/workbench-model';
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
  onApplyAnswerToPending?: (answer: string) => void;
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
  onApplyAnswerToPending,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [exported, setExported] = useState(false);
  const [csvExported, setCsvExported] = useState(false);
  const [bulkAnswer, setBulkAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [revision, setRevision] = useState<number | null>(null);
  const [preview, setPreview] = useState<SubmissionPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const isVqa = task === 'qa';
  const queueCount = isVqa ? vqaQueue.length : answers.length;
  const pendingCount = isVqa ? vqaQueue.filter((item) => item.status !== 'answered').length : 0;

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
      link.download = `aic-${safeFilenamePart(queryId)}-${task}.csv`;
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
            <article className={`answer-row answer-row--${item.status}`} key={item.key}>
              <span className="answer-rank">{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{item.video_id} · frame {item.frame_id}</strong>
                <small>
                  {item.status === 'answered' || item.status === 'abstained' || item.status === 'needs_more_evidence'
                    ? item.answer ?? 'Không biết'
                    : item.status === 'error' ? `Lỗi: ${item.error}` : 'Đang chờ answer'}
                </small>
              </div>
              <div className="answer-actions">
                <button type="button" aria-label={`Đưa frame ${item.frame_id} lên`} disabled={index === 0} onClick={() => onMoveVqaQueueItem?.(index, index - 1)}>↑</button>
                <button type="button" aria-label={`Đưa frame ${item.frame_id} xuống`} disabled={index === vqaQueue.length - 1} onClick={() => onMoveVqaQueueItem?.(index, index + 1)}>↓</button>
                <button type="button" aria-label={`Xóa frame ${item.frame_id}`} onClick={() => onRemoveVqaQueueItem?.(item.key)}>×</button>
              </div>
            </article>
          )) : answers.map((answer, index) => (
            <article className="answer-row" key={`${index}-${answer.video_id}`}>
              <span className="answer-rank">{String(index + 1).padStart(2, '0')}</span>
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
        </div>

        <footer>
          <span>{queueCount}/100 item · {answers.length} đã trả lời</span>
          <div className="answer-sync-actions">
            <button type="button" className="secondary-button" disabled={!answers.length || saving || previewing} onClick={saveAnswers}>
              {saving ? 'Đang lưu…' : 'Lưu đáp án'}
            </button>
            <button type="button" className="secondary-button" disabled={!answers.length || saving || previewing} onClick={createSubmissionPreview}>
              {previewing ? 'Đang tạo…' : 'Tạo preview'}
            </button>
          </div>
          <button type="button" className="secondary-button" disabled={!answers.length} onClick={copyPayload}>
            {copied ? 'Đã sao chép' : 'Sao chép JSON'}
          </button>
          <button type="button" className="secondary-button" disabled={!answers.length} onClick={exportCsv}>
            {csvExported ? 'Đã export CSV' : 'Export CSV'}
          </button>
          <button type="button" className="primary-button" disabled={!answers.length} onClick={exportPayload}>
            {exported ? 'Đã export' : 'Export JSON'}
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
