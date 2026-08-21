'use client';

import { createPortal } from 'react-dom';

import type { QualificationTask } from '../../lib/contracts';
import type { WorkbenchHistoryEntry } from '../../lib/workbench-history';

interface Props {
  open: boolean;
  entries: readonly WorkbenchHistoryEntry[];
  onClose: () => void;
  onRestore: (entry: WorkbenchHistoryEntry) => void;
  onRemove: (historyId: string) => void;
  onClear: () => void;
}

const TASK_LABELS: Record<QualificationTask, string> = {
  textual_kis: 'Textual KIS',
  qa: 'Hỏi & Đáp',
  trake: 'TRAKE',
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Không rõ thời gian';
  return new Intl.DateTimeFormat('vi-VN', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function historyButtonLabel(entry: WorkbenchHistoryEntry): string {
  return `Khôi phục ${TASK_LABELS[entry.task]}: ${entry.label}`;
}

export function HistoryPanel({ open, entries, onClose, onRestore, onRemove, onClear }: Props) {
  if (!open) return null;

  const panel = (
    <div className="history-modal-layer">
      <button type="button" className="history-modal-backdrop" aria-label="Đóng lịch sử query" onClick={onClose} />
      <section className="history-modal" role="dialog" aria-modal="true" aria-labelledby="history-modal-title">
        <header>
          <div>
            <p className="section-kicker">Các lần tìm kiếm gần đây</p>
            <h2 id="history-modal-title">Lịch sử query</h2>
          </div>
          <div className="history-modal-actions">
            {entries.length > 0 && (
              <button type="button" className="quiet-button" onClick={onClear}>Xóa tất cả</button>
            )}
            <button type="button" className="icon-button" aria-label="Đóng lịch sử query" onClick={onClose}>×</button>
          </div>
        </header>

        {entries.length === 0 ? (
          <p className="history-empty">Chưa có query thành công nào được lưu.</p>
        ) : (
          <ol className="history-list" aria-label="Danh sách lịch sử query">
            {entries.map((entry) => (
              <li key={entry.history_id} className="history-entry">
                <button
                  type="button"
                  className="history-entry-restore"
                  aria-label={historyButtonLabel(entry)}
                  onClick={() => onRestore(entry)}
                >
                  <span className="history-entry-task">{TASK_LABELS[entry.task]}</span>
                  <strong>{entry.label}</strong>
                  <small>{formatDate(entry.created_at)}</small>
                </button>
                <button
                  type="button"
                  className="icon-button history-entry-remove"
                  aria-label={`Xóa lịch sử ${entry.label}`}
                  onClick={() => onRemove(entry.history_id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );

  return typeof document === 'undefined' ? panel : createPortal(panel, document.body);
}
