'use client';

import { useEffect, useRef, useState } from 'react';

import type { QualificationAnswer, QualificationTask } from '../../lib/contracts';
import { buildSubmission } from '../../lib/workbench-model';

interface Props {
  open: boolean;
  task: QualificationTask;
  queryId: string;
  answers: readonly QualificationAnswer[];
  onClose: () => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
}

export function AnswerDrawer({ open, task, queryId, answers, onClose, onRemove, onMove }: Props) {
  const [copied, setCopied] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

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
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <button type="button" className="drawer-backdrop" aria-label="Đóng hàng đợi đáp án" onClick={onClose} />
      <aside ref={drawerRef} className="answer-drawer" role="dialog" aria-modal="true" aria-label="Hàng đợi đáp án" onKeyDown={trapFocus}>
        <header>
          <div>
            <p className="section-kicker">Bản nháp cục bộ</p>
            <h2>Hàng đợi đáp án</h2>
          </div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Đóng" onClick={onClose}>×</button>
        </header>

        <div className="answer-list">
          {answers.length === 0 && <p className="drawer-empty">Chưa có đáp án.</p>}
          {answers.map((answer, index) => (
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
        </div>

        <footer>
          <span>{answers.length}/100 đáp án</span>
          <button type="button" className="primary-button" disabled={!answers.length} onClick={copyPayload}>
            {copied ? 'Đã sao chép' : 'Sao chép JSON'}
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
