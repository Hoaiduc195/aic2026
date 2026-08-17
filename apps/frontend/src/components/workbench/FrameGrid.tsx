'use client';

import { type KeyboardEvent, useRef } from 'react';

import type { FrameCandidate } from '../../lib/contracts';
import { displayMatchedModalities, formatMs } from '../../lib/workbench-model';

interface Props {
  frames: readonly FrameCandidate[];
  selectedKey: string | null;
  loading: boolean;
  searched: boolean;
  skipped: number;
  onSelect: (frame: FrameCandidate) => void;
}

export function FrameGrid({ frames, selectedKey, loading, searched, skipped, onSelect }: Props) {
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || frames.length === 0) return;
    event.preventDefault();
    const current = Math.max(0, frames.findIndex((frame) => frame.result_key === selectedKey));
    const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const nextIndex = Math.max(0, Math.min(frames.length - 1, current + delta));
    onSelect(frames[nextIndex]);
    cardRefs.current[nextIndex]?.focus();
  }

  return (
    <section className="results-workspace" aria-labelledby="frame-results-title">
      <header className="workspace-heading">
        <div>
          <p className="section-kicker">Kết quả truy hồi</p>
          <h2 id="frame-results-title">Kết quả frame</h2>
        </div>
        <span className="result-summary">
          {loading ? 'Đang tìm' : searched ? `${frames.length} frame` : 'Chưa tìm kiếm'}
        </span>
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
            <button
              type="button"
              className={`frame-card${selected ? ' selected' : ''}`}
              key={frame.result_key}
              aria-label={`Chọn frame ${frame.video_id} · ${frame.original_frame_id}`}
              aria-pressed={selected}
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
          );
        })}
      </div>
    </section>
  );
}
