'use client';

import { type DragEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';

import type { FrameCandidate } from '../../lib/contracts';
import { displayMatchedModalities, formatMs } from '../../lib/workbench-model';

interface Props {
  frames: readonly FrameCandidate[];
  selectedKey: string | null;
  loading: boolean;
  searched: boolean;
  skipped: number;
  onSelect: (frame: FrameCandidate) => void;
  onReorder: (from: number, to: number) => void;
  onExport?: () => void;
}

export function FrameGrid({
  frames,
  selectedKey,
  loading,
  searched,
  skipped,
  onSelect,
  onReorder,
  onExport,
}: Props) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [focusResultKey, setFocusResultKey] = useState<string | null>(null);

  useEffect(() => {
    if (!focusResultKey) return;
    const target = cardRefs.current.find((button) => button?.dataset.resultKey === focusResultKey);
    if (!target) return;
    target.focus();
    setFocusResultKey(null);
  }, [focusResultKey, frames]);

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || frames.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, frames.findIndex((frame) => frame.result_key === selectedKey));
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(frames.length - 1, current + delta));
    onSelect(frames[nextIndex]);
    cardRefs.current[nextIndex]?.focus();
  }

  function handleDragStart(event: DragEvent<HTMLElement>, index: number) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
    setDraggedIndex(index);
    setDragOverIndex(index);
  }

  function handleDrop(event: DragEvent<HTMLElement>, index: number) {
    event.preventDefault();
    const rawDataIndex = event.dataTransfer.getData('text/plain');
    const dataIndex = rawDataIndex === '' ? null : Number(rawDataIndex);
    const sourceIndex = draggedIndex ?? (dataIndex !== null && Number.isInteger(dataIndex) ? dataIndex : null);
    if (sourceIndex !== null && Number.isInteger(sourceIndex)) {
      onReorder(sourceIndex, index);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }

  function clearDragState() {
    setDraggedIndex(null);
    setDragOverIndex(null);
  }

  function moveWithKeyboard(index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= frames.length) return;
    setFocusResultKey(frames[index].result_key);
    onReorder(index, index + offset);
  }

  return (
    <section className="results-workspace" aria-labelledby="frame-results-title">
      <header className="workspace-heading">
        <div>
          <p className="section-kicker">Kết quả truy hồi</p>
          <h2 id="frame-results-title">Kết quả frame</h2>
        </div>
        <div className="workspace-heading-actions">
          <span className="result-summary">
            {loading ? 'Đang tìm' : searched ? `${frames.length} frame` : 'Chưa tìm kiếm'}
          </span>
          {onExport && searched && (
            <button
              type="button"
              className="secondary-button result-export-button"
              disabled={frames.length === 0}
              onClick={onExport}
            >
              Xuất JSON top 100
            </button>
          )}
        </div>
      </header>

      {skipped > 0 && (
        <p className="inline-warning" role="status">
          Đã bỏ qua {skipped} kết quả chưa có representative frame.
        </p>
      )}

      {!searched && !loading && (
        <div className="empty-state">
          <span aria-hidden="true">⌗</span>
          <h3>Nhập mô tả để bắt đầu</h3>
          <p>Các frame phù hợp nhất sẽ xuất hiện tại đây.</p>
        </div>
      )}
      {searched && frames.length === 0 && (
        <div className="empty-state">
          <h3>Không tìm thấy frame phù hợp</h3>
          <p>Hãy thử mô tả ngắn hơn hoặc dùng từ khóa khác.</p>
        </div>
      )}

      <div className="frame-grid" tabIndex={frames.length ? 0 : undefined} onKeyDown={handleKeys}>
        {frames.map((frame, index) => {
          const selected = frame.result_key === selectedKey;
          const modalityLabel = displayMatchedModalities(frame.matched_modalities);
          return (
            <article
              className={`frame-card${selected ? ' selected' : ''}${draggedIndex === index ? ' dragging' : ''}${dragOverIndex === index && draggedIndex !== index ? ' drag-over' : ''}`}
              key={frame.result_key}
              draggable
              onDragStart={(event) => handleDragStart(event, index)}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverIndex(index);
              }}
              onDragLeave={() => {
                if (dragOverIndex === index) setDragOverIndex(null);
              }}
              onDrop={(event) => handleDrop(event, index)}
              onDragEnd={clearDragState}
            >
              <button
                type="button"
                className="frame-card-select"
                aria-label={`Chọn frame ${frame.video_id} · ${frame.original_frame_id}`}
                aria-pressed={selected}
                data-result-key={frame.result_key}
                ref={(element) => { cardRefs.current[index] = element; }}
                onClick={() => onSelect(frame)}
              >
                <div className="frame-thumbnail">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={frame.thumbnail_uri} alt="" loading="lazy" />
                  <span className="rank-label">#{index + 1}</span>
                  <span className="score-label">{Math.round(frame.score * 100)}%</span>
                </div>
                <div className="frame-card-body">
                  <strong>{frame.video_id}</strong>
                  <span>Frame {frame.original_frame_id} · {formatMs(frame.timestamp_ms)}</span>
                  <small>{modalityLabel || '—'}</small>
                </div>
              </button>
              <div className="frame-card-controls" onKeyDown={(event) => event.stopPropagation()}>
                <span className="drag-hint">Kéo để xếp hạng</span>
                <button
                  type="button"
                  aria-label={`Đưa frame ${frame.video_id} · ${frame.original_frame_id} lên`}
                  disabled={index === 0}
                  onClick={() => moveWithKeyboard(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Đưa frame ${frame.video_id} · ${frame.original_frame_id} xuống`}
                  disabled={index === frames.length - 1}
                  onClick={() => moveWithKeyboard(index, 1)}
                >
                  ↓
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
