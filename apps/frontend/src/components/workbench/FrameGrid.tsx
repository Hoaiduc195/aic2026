'use client';

import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import type { FrameCandidate } from '../../lib/contracts';
import {
  displayMatchedModalities,
  frameCandidateDisplayLabel,
  frameCandidateLabel,
  formatMs,
} from '../../lib/workbench-model';
import { queueKey } from '../../lib/vqa-queue-model';

interface Props {
  frames: readonly FrameCandidate[];
  selectedKey: string | null;
  loading: boolean;
  searched: boolean;
  skipped: number;
  onSelect: (frame: FrameCandidate) => void;
  onReorder: (from: number, to: number) => void;
  onMoveToTop?: (frame: FrameCandidate) => void;
  onMoveToBottom?: (frame: FrameCandidate) => void;
  onQueryFrame?: (frame: FrameCandidate) => void;
  onExportTrakeCsv?: () => void;
  trakeFrameSelections?: Readonly<Record<string, readonly FrameCandidate[]>>;
  queueKeys?: ReadonlySet<string>;
  queueCount?: number;
  onAddToQueue?: (frame: FrameCandidate) => void;
  onFillQueue?: () => void;
  queueLabel?: string;
  batchTopK?: string;
  onBatchTopKChange?: (value: string) => void;
  onRunBatchVqa?: () => void;
  onStopBatchVqa?: () => void;
  batchVqaLoading?: boolean;
  batchVqaProgress?: { completed: number; total: number; failed: number } | null;
}

interface PendingPointerDrag {
  pointerId: number;
  sourceIndex: number;
  sourceKey: string;
  startX: number;
  startY: number;
  started: boolean;
}

export function FrameGrid({
  frames,
  selectedKey,
  loading,
  searched,
  skipped,
  onSelect,
  onReorder,
  onMoveToTop,
  onMoveToBottom,
  onQueryFrame,
  onExportTrakeCsv,
  trakeFrameSelections = {},
  queueKeys = new Set<string>(),
  queueCount = 0,
  onAddToQueue,
  onFillQueue,
  queueLabel,
  batchTopK = '10',
  onBatchTopKChange,
  onRunBatchVqa,
  onStopBatchVqa,
  batchVqaLoading = false,
  batchVqaProgress = null,
}: Props) {
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const listRef = useRef<HTMLOListElement | null>(null);
  const frameRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const animatedNodesRef = useRef<HTMLElement[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const animationTimeoutRef = useRef<number | null>(null);
  const pointerDragRef = useRef<PendingPointerDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [pointerPosition, setPointerPosition] = useState<{ x: number; y: number } | null>(null);
  const [previewSize, setPreviewSize] = useState<{ width: number; height: number } | null>(null);
  const [focusResultKey, setFocusResultKey] = useState<string | null>(null);
  const [queryFrame, setQueryFrame] = useState<FrameCandidate | null>(null);

  useEffect(() => {
    if (!focusResultKey) return;
    const target = cardRefs.current[focusResultKey];
    if (!target) return;
    target.focus();
    setFocusResultKey(null);
  }, [focusResultKey, frames]);

  useEffect(() => {
    if (!queryFrame) return undefined;
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') setQueryFrame(null);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [queryFrame]);

  function resetMotion() {
    if (animationFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (animationTimeoutRef.current !== null && typeof window !== 'undefined') {
      window.clearTimeout(animationTimeoutRef.current);
      animationTimeoutRef.current = null;
    }
    animatedNodesRef.current.forEach((node) => {
      node.style.transition = '';
      node.style.transform = '';
    });
    animatedNodesRef.current = [];
  }

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;

    const nodes = Array.from(list.querySelectorAll<HTMLElement>('[data-frame-key]'))
      .filter((node) => node.dataset.frameKey !== draggedKey);
    const previousRects = frameRectsRef.current;
    const nextRects = new Map(
      nodes.flatMap((node) => {
        const key = node.dataset.frameKey;
        return key ? [[key, node.getBoundingClientRect()] as const] : [];
      }),
    );
    const prefersReducedMotion = typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    resetMotion();
    if (!prefersReducedMotion && previousRects.size > 0) {
      const movedNodes = nodes.filter((node) => {
        const key = node.dataset.frameKey;
        const previous = key ? previousRects.get(key) : undefined;
        const current = node.getBoundingClientRect();
        if (!previous) return false;

        const deltaX = previous.left - current.left;
        const deltaY = previous.top - current.top;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return false;
        node.style.transition = 'none';
        node.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`;
        return true;
      });

      if (
        movedNodes.length > 0
        && typeof window !== 'undefined'
        && typeof window.requestAnimationFrame === 'function'
      ) {
        animatedNodesRef.current = movedNodes;
        animationFrameRef.current = window.requestAnimationFrame(() => {
          movedNodes.forEach((node) => {
            node.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)';
            node.style.transform = 'translate3d(0, 0, 0)';
          });
          animationFrameRef.current = null;
          animationTimeoutRef.current = window.setTimeout(resetMotion, 220);
        });
      }
    }

    frameRectsRef.current = nextRects;
    return resetMotion;
  }, [frames, draggedKey, dropIndex]);

  function handleKeys(event: KeyboardEvent<HTMLOListElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || frames.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, frames.findIndex((frame) => frame.result_key === selectedKey));
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(frames.length - 1, current + delta));
    onSelect(frames[nextIndex]);
    cardRefs.current[frames[nextIndex].result_key]?.focus();
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>, index: number) {
    if (event.button !== undefined && event.button !== 0) return;
    const frame = frames[index];
    if (!frame) return;

    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest('.frame-card-controls')) return;

    pointerDragRef.current = {
      pointerId: event.pointerId,
      sourceIndex: index,
      sourceKey: frame.result_key,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
    };
    suppressClickRef.current = false;
    setPointerPosition(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    setPreviewSize(bounds.width > 0 && bounds.height > 0
      ? { width: bounds.width, height: bounds.height }
      : null);
  }

  function handlePointerMove(
    event: PointerEvent<HTMLElement>,
    targetKey?: string,
    targetElement?: HTMLElement,
    placeholderPosition?: number,
  ) {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;

    if (!pending.started) {
      const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
      if (distance < 6) return;

      pointerDragRef.current = { ...pending, started: true };
      suppressClickRef.current = true;
      setDraggedKey(pending.sourceKey);
      setDropIndex(pending.sourceIndex);
    }

    setPointerPosition({ x: event.clientX, y: event.clientY });

    const sourceKey = pending.sourceKey;
    if (placeholderPosition !== undefined) {
      setDropIndex((current) => current === placeholderPosition ? current : placeholderPosition);
      return;
    }

    const eventTarget = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[data-frame-key]')
      : null;
    const resolvedTarget = targetElement ?? eventTarget;
    const resolvedKey = targetKey ?? resolvedTarget?.dataset.frameKey;
    if (!resolvedKey || resolvedKey === sourceKey) return;

    const visibleFrames = frames.filter((frame) => frame.result_key !== sourceKey);
    const targetIndex = visibleFrames.findIndex((frame) => frame.result_key === resolvedKey);
    if (targetIndex < 0) return;

    const bounds = resolvedTarget?.getBoundingClientRect();
    if (!bounds) return;
    const insertAfter = event.clientY > bounds.top + bounds.height / 2;
    const nextDropIndex = targetIndex + (insertAfter ? 1 : 0);
    setDropIndex((current) => current === nextDropIndex ? current : nextDropIndex);
  }

  function handlePointerUp(event: PointerEvent<HTMLElement>) {
    const pending = pointerDragRef.current;
    if (!pending || pending.pointerId !== event.pointerId) return;

    const sourceKey = pending.sourceKey;
    const sourceIndex = frames.findIndex((frame) => frame.result_key === sourceKey);
    const targetIndex = dropIndex ?? sourceIndex;
    if (sourceIndex >= 0 && targetIndex >= 0 && targetIndex < frames.length) {
      onReorder(sourceIndex, targetIndex);
    }
    clearPointerDrag();
  }

  function clearPointerDrag() {
    pointerDragRef.current = null;
    setDraggedKey(null);
    setDropIndex(null);
    setPointerPosition(null);
    setPreviewSize(null);
  }

  function cancelPointerDrag() {
    pointerDragRef.current = null;
    suppressClickRef.current = false;
    setDraggedKey(null);
    setDropIndex(null);
    setPointerPosition(null);
    setPreviewSize(null);
  }

  function moveWithKeyboard(index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= frames.length) return;
    setFocusResultKey(frames[index].result_key);
    onReorder(index, index + offset);
  }

  const entries = buildListEntries(frames, draggedKey, dropIndex);
  const draggedFrame = draggedKey
    ? frames.find((frame) => frame.result_key === draggedKey) ?? null
    : null;
  const draggedRank = draggedFrame
    ? frames.findIndex((frame) => frame.result_key === draggedFrame.result_key) + 1
    : null;

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
          {(onFillQueue || onExportTrakeCsv) && searched && (
            <div className={onRunBatchVqa ? 'vqa-result-toolbar' : 'result-queue-toolbar'} aria-label="Công cụ hàng đợi">
              {onFillQueue && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={frames.length === 0}
                  onClick={onFillQueue}
                >
                  {queueLabel ?? `Lấy top 100 frame vào hàng đợi (${queueCount}/100)`}
                </button>
              )}
              {onRunBatchVqa && (
                <>
                  <label className="batch-k-control">
                    <span>Top-K</span>
                    <input
                      aria-label="Số frame batch VQA"
                      type="number"
                      min="1"
                      max="100"
                      inputMode="numeric"
                      value={batchTopK}
                      onChange={(event) => onBatchTopKChange?.(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={frames.length === 0}
                    onClick={batchVqaLoading ? onStopBatchVqa : onRunBatchVqa}
                  >
                    {batchVqaLoading ? 'Dừng batch' : 'LLM trả lời Top-K'}
                  </button>
                  {batchVqaProgress && (
                    <span className="batch-progress" role="status">
                      {batchVqaProgress.completed}/{batchVqaProgress.total}
                      {batchVqaProgress.failed > 0 ? ` · lỗi ${batchVqaProgress.failed}` : ''}
                    </span>
                  )}
                </>
              )}
              {onExportTrakeCsv && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={frames.length === 0}
                  onClick={onExportTrakeCsv}
                >
                  Xuất CSV top 100
                </button>
              )}
            </div>
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
        ref={listRef}
        className="frame-list frame-list-animated"
        aria-label="Danh sách kết quả frame"
        tabIndex={frames.length ? 0 : undefined}
        onKeyDown={handleKeys}
        onPointerMove={(event) => handlePointerMove(event)}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelPointerDrag}
      >
        {entries.map((entry, entryIndex) => {
          if (entry.kind === 'placeholder') {
            return (
              <li
                className="frame-list-placeholder"
                key={`placeholder-${entry.position}`}
                data-drop-index={entry.position}
                onPointerMove={(event) => handlePointerMove(event, undefined, event.currentTarget, entry.position)}
                onPointerUp={handlePointerUp}
              >
                <span aria-hidden="true">↕</span>
                <span>Thả để xếp ở vị trí #{entry.position + 1}</span>
              </li>
            );
          }

          const { frame } = entry;
          const index = frames.findIndex((candidate) => candidate.result_key === frame.result_key);
          const rank = entries
            .slice(0, entryIndex)
            .filter((candidate) => candidate.kind === 'placeholder' || !candidate.dragging)
            .length + 1;
          const selected = frame.result_key === selectedKey;
          const frameQueueKey = queueKey(frame);
          const queued = queueKeys.has(frameQueueKey);
          const modalityLabel = displayMatchedModalities(frame.matched_modalities);
          const resultLabel = frameCandidateLabel(frame);
          const displayLabel = frameCandidateDisplayLabel(frame);
          const selectedTrakeFrames = trakeFrameSelections[frame.result_key] ?? [];
          return (
            <li
              className={`frame-card frame-list-item frame-list-item--spacious${entry.dragging ? ' frame-list-item--dragging' : ''}${selected ? ' selected' : ''}`}
              data-queued={queued ? 'true' : undefined}
              data-frame-key={frame.result_key}
              key={frame.result_key}
              onPointerDown={(event) => handlePointerDown(event, index)}
              onPointerMove={(event) => handlePointerMove(event, frame.result_key, event.currentTarget)}
              onPointerUp={handlePointerUp}
              onPointerCancel={cancelPointerDrag}
            >
              <div className="frame-list-main">
                <span className="frame-drag-handle" aria-hidden="true">⠿</span>
                <button
                  type="button"
                  className="frame-card-select"
                  aria-label={`Chọn ${resultLabel}`}
                  aria-pressed={selected}
                  data-result-key={frame.result_key}
                  ref={(element) => { cardRefs.current[frame.result_key] = element; }}
                  onClick={(event) => {
                    if (suppressClickRef.current) {
                      event.preventDefault();
                      event.stopPropagation();
                      suppressClickRef.current = false;
                      return;
                    }
                    onSelect(frame);
                  }}
                >
                  <div className="frame-thumbnail">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={frame.thumbnail_uri} alt="" loading="lazy" />
                    <span className="rank-label">#{rank}</span>
                    <span className="score-label">{Math.round(frame.score * 100)}%</span>
                  </div>
                  <div className="frame-card-body">
                    <strong>{frame.video_id}</strong>
                    <span>{displayLabel} · {formatMs(frame.timestamp_ms)}</span>
                    <small>{modalityLabel || '—'}</small>
                    {selectedTrakeFrames.length > 0 && (
                      <small className="trake-selection-summary">
                        Đang chọn: {selectedTrakeFrames.map((selectedFrame) => selectedFrame.original_frame_id).join(' → ')}
                      </small>
                    )}
                  </div>
                </button>
              </div>
              <div className="frame-card-controls" onKeyDown={(event) => event.stopPropagation()}>
                <span className="drag-hint">Kéo để xếp hạng</span>
                {onAddToQueue && (
                  <button
                    type="button"
                    className="queue-card-action"
                    aria-label={queued ? `Frame ${resultLabel} đã ở hàng đợi` : `Thêm ${resultLabel} vào hàng đợi`}
                    disabled={queued}
                    onClick={() => onAddToQueue(frame)}
                  >
                    {queued ? '✓' : '+'}
                  </button>
                )}
                {onMoveToTop && (
                  <button
                    type="button"
                    className="queue-card-action frame-boundary-action"
                    aria-label={`Upvote ${resultLabel} — đưa lên đầu`}
                    disabled={index === 0}
                    onClick={() => onMoveToTop(frame)}
                  >
                    ⤒
                  </button>
                )}
                {onMoveToBottom && (
                  <button
                    type="button"
                    className="queue-card-action frame-boundary-action"
                    aria-label={`Downvote ${resultLabel} — đưa xuống cuối`}
                    disabled={index === frames.length - 1}
                    onClick={() => onMoveToBottom(frame)}
                  >
                    ⤓
                  </button>
                )}
                {onQueryFrame && (
                  <button
                    type="button"
                    className="queue-card-action frame-query-action"
                    aria-label={`Tìm kiếm bằng ${resultLabel}`}
                    onClick={() => setQueryFrame(frame)}
                  >
                    ⌕
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Đưa ${resultLabel} lên`}
                  disabled={index === 0}
                  onClick={() => moveWithKeyboard(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Đưa ${resultLabel} xuống`}
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
      {draggedFrame && pointerPosition && draggedRank !== null && (
        <DragPreview
          frame={draggedFrame}
          rank={draggedRank}
          position={pointerPosition}
          size={previewSize}
        />
      )}
      {queryFrame && onQueryFrame && (
        <div
          className="frame-query-modal-layer"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setQueryFrame(null);
          }}
        >
          <div
            className="frame-query-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="frame-query-title"
            aria-describedby="frame-query-description"
          >
            <p className="section-kicker">Image-only retrieval</p>
            <h2 id="frame-query-title">Xác nhận tìm kiếm trên frame này</h2>
            <p id="frame-query-description">
              Backend sẽ dùng đúng ảnh của <strong>{queryFrame.video_id} · frame {queryFrame.original_frame_id}</strong> để tìm các frame tương tự.
            </p>
            <div className="frame-query-preview">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={queryFrame.thumbnail_uri} alt={`Frame ${queryFrame.original_frame_id}`} />
            </div>
            <div className="frame-query-actions">
              <button type="button" className="secondary-button" onClick={() => setQueryFrame(null)}>Huỷ</button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  const selectedFrame = queryFrame;
                  setQueryFrame(null);
                  onQueryFrame(selectedFrame);
                }}
              >
                Xác nhận tìm kiếm
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function DragPreview({
  frame,
  rank,
  position,
  size,
}: {
  frame: FrameCandidate;
  rank: number;
  position: { x: number; y: number };
  size: { width: number; height: number } | null;
}) {
  const modalityLabel = displayMatchedModalities(frame.matched_modalities);
  const resultLabel = frameCandidateLabel(frame);
  const displayLabel = frameCandidateDisplayLabel(frame);
  return (
    <div
      className="frame-card frame-list-item frame-list-item--spacious frame-drag-preview"
      role="img"
      aria-label={`Đang kéo ${resultLabel}`}
      style={{
        width: size ? `${size.width}px` : undefined,
        height: size ? `${size.height}px` : undefined,
        transform: `translate3d(${position.x + 14}px, ${position.y + 14}px, 0)`,
      }}
    >
      <div className="frame-list-main">
        <span className="frame-drag-handle" aria-hidden="true">⠿</span>
        <div className="frame-card-select frame-drag-preview-select">
          <div className="frame-thumbnail">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={frame.thumbnail_uri} alt="" />
            <span className="rank-label">#{rank}</span>
            <span className="score-label">{Math.round(frame.score * 100)}%</span>
          </div>
          <div className="frame-card-body">
            <strong>{frame.video_id}</strong>
            <span>{displayLabel} · {formatMs(frame.timestamp_ms)}</span>
            <small>{modalityLabel || '—'}</small>
          </div>
        </div>
      </div>
      <div className="frame-card-controls frame-drag-preview-controls" aria-hidden="true">
        <span className="drag-hint">Kéo để xếp hạng</span>
        <span className="frame-drag-preview-button">⤒</span>
        <span className="frame-drag-preview-button">⤓</span>
        <span className="frame-drag-preview-button">↑</span>
        <span className="frame-drag-preview-button">↓</span>
      </div>
    </div>
  );
}

type ListEntry =
  | { kind: 'frame'; frame: FrameCandidate; dragging?: boolean }
  | { kind: 'placeholder'; position: number };

function buildListEntries(
  frames: readonly FrameCandidate[],
  draggedKey: string | null,
  dropIndex: number | null,
): ListEntry[] {
  if (!draggedKey || dropIndex === null) {
    return frames.map((frame) => ({ kind: 'frame', frame }));
  }

  const sourceIndex = frames.findIndex((frame) => frame.result_key === draggedKey);
  if (sourceIndex < 0) return frames.map((frame) => ({ kind: 'frame', frame }));

  const visibleLength = frames.length - 1;
  const insertionIndex = Math.min(Math.max(dropIndex, 0), visibleLength);
  const entries: ListEntry[] = [];
  let visibleIndex = 0;
  let placeholderAdded = false;

  frames.forEach((frame) => {
    if (!placeholderAdded && visibleIndex === insertionIndex) {
      entries.push({ kind: 'placeholder', position: insertionIndex });
      placeholderAdded = true;
    }

    if (frame.result_key === draggedKey) {
      entries.push({ kind: 'frame', frame, dragging: true });
      return;
    }

    entries.push({ kind: 'frame', frame });
    visibleIndex += 1;
  });

  if (!placeholderAdded) {
    entries.push({ kind: 'placeholder', position: insertionIndex });
  }
  return entries;
}
