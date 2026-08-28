import type { FrameCandidate, VideoFrame } from '../../lib/contracts';
import {
  MAX_NEARBY_FRAME_COUNT,
  MAX_NEARBY_FRAME_STEP,
  MIN_NEARBY_FRAME_COUNT,
  MIN_NEARBY_FRAME_STEP,
  parseNearbyFrameCount,
  parseNearbyFrameStep,
} from '../../lib/nearby-frame-model';

interface NearbyFramePanelProps {
  readonly frames: readonly FrameCandidate[];
  readonly centerFrame: FrameCandidate | null;
  readonly nearbyFrames: readonly VideoFrame[];
  readonly frameCount: string;
  readonly frameStep: string;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onCenterChange: (frame: FrameCandidate) => void;
  readonly onFrameCountChange: (value: string) => void;
  readonly onFrameStepChange: (value: string) => void;
  readonly onLoad: () => void;
  readonly onExport: () => void;
}

export function NearbyFramePanel({
  frames,
  centerFrame,
  nearbyFrames,
  frameCount,
  frameStep,
  loading,
  error,
  onCenterChange,
  onFrameCountChange,
  onFrameStepChange,
  onLoad,
  onExport,
}: NearbyFramePanelProps) {
  const centerOptions = centerFrame && !frames.some((frame) => frame.result_key === centerFrame.result_key)
    ? [centerFrame, ...frames]
    : frames;
  const parsedFrameCount = parseNearbyFrameCount(frameCount);
  const parsedFrameStep = parseNearbyFrameStep(frameStep);
  const hasCenter = centerFrame !== null;

  return (
    <section className="nearby-frame-panel" aria-labelledby="nearby-frame-title">
      <div className="nearby-frame-panel-heading">
        <div>
          <p className="section-kicker">Context export</p>
          <h2 id="nearby-frame-title">Frame lân cận</h2>
        </div>
        <span className="nearby-frame-panel-badge">1–{MAX_NEARBY_FRAME_COUNT} frame</span>
      </div>
      <p className="nearby-frame-panel-description">
        Chọn frame tâm, đặt Top-K và khoảng cách theo frame nguồn để bao quát ngữ cảnh lân cận rồi tải dữ liệu.
      </p>

      <div className="nearby-frame-controls">
        <label className="input-field compact-field">
          <span>Frame trung tâm</span>
          <select
            aria-label="Frame trung tâm cho cửa sổ lân cận"
            value={centerFrame?.result_key ?? ''}
            disabled={!hasCenter || loading}
            onChange={(event) => {
              const nextFrame = centerOptions.find((frame) => frame.result_key === event.target.value);
              if (nextFrame) onCenterChange(nextFrame);
            }}
          >
            {!hasCenter && <option value="">Chưa có frame tâm</option>}
            {centerOptions.map((frame) => (
              <option key={frame.result_key} value={frame.result_key}>
                {frame.video_id} · frame #{frame.original_frame_id}
              </option>
            ))}
          </select>
        </label>
        <label className="input-field compact-field">
          <span>Top-K frame bao quát (gồm frame tâm)</span>
          <input
            aria-label="Top-K frame bao quát"
            type="number"
            min={MIN_NEARBY_FRAME_COUNT}
            max={MAX_NEARBY_FRAME_COUNT}
            step="1"
            inputMode="numeric"
            value={frameCount}
            onChange={(event) => onFrameCountChange(event.target.value)}
          />
        </label>
        <label className="input-field compact-field">
          <span>Khoảng cách giữa các frame (frame nguồn)</span>
          <input
            aria-label="Khoảng cách giữa các frame (frame nguồn)"
            type="number"
            min={MIN_NEARBY_FRAME_STEP}
            max={MAX_NEARBY_FRAME_STEP}
            step="1"
            inputMode="numeric"
            value={frameStep}
            onChange={(event) => onFrameStepChange(event.target.value)}
          />
        </label>
      </div>

      <div className="nearby-frame-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!hasCenter || parsedFrameCount === null || parsedFrameStep === null || loading}
          onClick={onLoad}
        >
          {loading ? 'Đang tải…' : 'Tải frame lân cận'}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!hasCenter || nearbyFrames.length === 0 || loading}
          onClick={onExport}
        >
          Xuất CSV frame lân cận
        </button>
      </div>

      {centerFrame && (
        <p className="nearby-frame-center-summary">
          Frame tâm hiện tại: <strong>{centerFrame.video_id} · frame #{centerFrame.original_frame_id}</strong>
        </p>
      )}
      {loading && <p className="nearby-frame-status" role="status">Đang tải frame lân cận…</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {nearbyFrames.length > 0 ? (
        <ol className="nearby-frame-list" aria-label="Danh sách frame lân cận đã tải">
          {nearbyFrames.map((frame) => {
            const isCenter = frame.video_id === centerFrame?.video_id
              && frame.original_frame_id === centerFrame.original_frame_id;
            return (
              <li
                className={`nearby-frame-item${isCenter ? ' is-center' : ''}`}
                key={`${frame.video_id}\u0000${frame.original_frame_id}`}
              >
                <div>
                  <strong>{frame.video_id}</strong>
                  <span>Frame {frame.original_frame_id} · {formatTimestamp(frame.timestamp_ms)}</span>
                </div>
                {isCenter && <span className="nearby-frame-center-badge">Frame tâm</span>}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="nearby-frame-empty">Chưa tải cửa sổ frame nào.</p>
      )}
    </section>
  );
}

function formatTimestamp(timestampMs: number): string {
  const totalSeconds = Math.floor(timestampMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
