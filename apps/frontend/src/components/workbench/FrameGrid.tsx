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
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [focusResultKey, setFocusResultKey] = useState<string | null>(null);

  useEffect(() => {
    if (!focusResultKey) return;
    const target = cardRefs.current[focusResultKey];
    if (!target) return;
    target.focus();
    setFocusResultKey(null);
  }, [focusResultKey, frames]);

  function handleKeys(event: KeyboardEvent<HTMLOListElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || frames.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, frames.findIndex((frame) => frame.result_key === selectedKey));
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(frames.length - 1, current + delta));
    onSelect(frames[nextIndex]);
    cardRefs.current[frames[nextIndex].result_key]?.focus();
  }

  function handleDragStart(event: DragEvent<HTMLElement>, index: number) {
    const frame = frames[index];
    if (!frame) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-aic-result-key', frame.result_key);
    event.dataTransfer.setData('text/plain', frame.result_key);
    setDraggedKey(frame.result_key);
    setDropIndex(index);
  }

  function handleDragOver(event: DragEvent<HTMLElement>, targetKey: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const sourceKey = draggedKey ?? readDraggedKey(event, frames);
    if (!sourceKey || sourceKey === targetKey) return;

    const visibleFrames = frames.filter((frame) => frame.result_key !== sourceKey);
    const targetIndex = visibleFrames.findIndex((frame) => frame.result_key === targetKey);
    if (targetIndex < 0) return;

    const bounds = event.currentTarget.getBoundingClientRect();
    const insertAfter = event.clientY > bounds.top + bounds.height / 2;
    setDropIndex(targetIndex + (insertAfter ? 1 : 0));
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const sourceKey = draggedKey ?? readDraggedKey(event, frames);
    const sourceIndex = sourceKey ? frames.findIndex((frame) => frame.result_key === sourceKey) : -1;
    const targetIndex = dropIndex ?? sourceIndex;
    if (sourceIndex >= 0 && targetIndex >= 0 && targetIndex < frames.length) {
      onReorder(sourceIndex, targetIndex);
    }
    clearDragState();
  }

  function clearDragState() {
    setDraggedKey(null);
    setDropIndex(null);
  }

  function moveWithKeyboard(index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= frames.length) return;
    setFocusResultKey(frames[index].result_key);
    onReorder(index, index + offset);
  }

  const visibleFrames = draggedKey
    ? frames.filter((frame) => frame.result_key !== draggedKey)
    : frames;
  const entries: ListEntry[] = draggedKey && dropIndex !== null
    ? [
        ...visibleFrames.slice(0, Math.min(dropIndex, visibleFrames.length)).map((frame) => ({ kind: 'frame' as const, frame })),
        { kind: 'placeholder' as const, position: Math.min(dropIndex, visibleFrames.length) },
        ...visibleFrames.slice(Math.min(dropIndex, visibleFrames.length)).map((frame) => ({ kind: 'frame' as const, frame })),
      ]
    : frames.map((frame) => ({ kind: 'frame' as const, frame }));

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

      <ol
        className="frame-list"
        aria-label="Danh sách kết quả frame"
        tabIndex={frames.length ? 0 : undefined}
        onKeyDown={handleKeys}
      >
        {entries.map((entry, entryIndex) => {
          if (entry.kind === 'placeholder') {
            return (
              <li
                className="frame-list-placeholder"
                key={`placeholder-${entry.position}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  setDropIndex(entry.position);
                }}
                onDrop={handleDrop}
              >
                <span aria-hidden="true">↕</span>
                <span>Thả để xếp ở vị trí #{entry.position + 1}</span>
              </li>
            );
          }

          const { frame } = entry;
          const index = frames.findIndex((candidate) => candidate.result_key === frame.result_key);
          const rank = entryIndex + 1;
          const selected = frame.result_key === selectedKey;
          const modalityLabel = displayMatchedModalities(frame.matched_modalities);
          return (
            <li
              className={`frame-card frame-list-item${selected ? ' selected' : ''}`}
              key={frame.result_key}
              draggable
              onDragStart={(event) => handleDragStart(event, index)}
              onDragOver={(event) => handleDragOver(event, frame.result_key)}
              onDrop={handleDrop}
              onDragEnd={clearDragState}
            >
              <div className="frame-list-main">
                <span className="frame-drag-handle" aria-hidden="true">⠿</span>
                <button
                  type="button"
                  className="frame-card-select"
                  aria-label={`Chọn frame ${frame.video_id} · ${frame.original_frame_id}`}
                  aria-pressed={selected}
                  data-result-key={frame.result_key}
                  ref={(element) => { cardRefs.current[frame.result_key] = element; }}
                  onClick={() => onSelect(frame)}
                >
                  <div className="frame-thumbnail">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={frame.thumbnail_uri} alt="" loading="lazy" />
                    <span className="rank-label">#{rank}</span>
                    <span className="score-label">{Math.round(frame.score * 100)}%</span>
                  </div>
                  <div className="frame-card-body">
                    <strong>{frame.video_id}</strong>
                    <span>Frame {frame.original_frame_id} · {formatMs(frame.timestamp_ms)}</span>
                    <small>{modalityLabel || '—'}</small>
                  </div>
                </button>
              </div>
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
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type ListEntry =
  | { kind: 'frame'; frame: FrameCandidate }
  | { kind: 'placeholder'; position: number };

function readDraggedKey(event: DragEvent<HTMLElement>, frames: readonly FrameCandidate[]): string | null {
  const rawValue = event.dataTransfer.getData('application/x-aic-result-key')
    || event.dataTransfer.getData('text/plain');
  if (!rawValue) return null;
  if (frames.some((frame) => frame.result_key === rawValue)) return rawValue;
  const legacyIndex = Number(rawValue);
  return Number.isInteger(legacyIndex) ? frames[legacyIndex]?.result_key ?? null : null;
}
