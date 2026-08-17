'use client';

import { useMemo } from 'react';

import type { StudioAsrSpan, StudioFrame } from '../../lib/contracts';
import { formatMs } from '../../lib/workbench-model';
import { timelinePercent } from '../../lib/video-studio-model';

interface Props {
  durationMs: number;
  currentTimeMs: number;
  frames: readonly StudioFrame[];
  asrSpans: readonly StudioAsrSpan[];
  selectedFrameId: number | null;
  onSeek: (timestampMs: number) => void;
  onFrameSelect: (frame: StudioFrame) => void;
}

interface AsrLane {
  span: StudioAsrSpan;
  lane: number;
}

const LANE_HEIGHT = 24;
const FRAME_TRACK_HEIGHT = 30;
const MAX_ASR_LANES = 2;

export function VideoTimelineOverlay({
  durationMs,
  currentTimeMs,
  frames,
  asrSpans,
  selectedFrameId,
  onSeek,
  onFrameSelect,
}: Props) {
  const lanes = useMemo(() => assignAsrLanes(asrSpans), [asrSpans]);
  const asrLaneCount = lanes.length === 0
    ? 0
    : Math.max(...lanes.map(({ lane }) => lane + 1));
  const timelineHeight = (asrLaneCount * LANE_HEIGHT) + FRAME_TRACK_HEIGHT;
  const playhead = timelinePercent(currentTimeMs, durationMs);

  return (
    <section className="video-timeline" aria-label="Timeline video">
      <div className="video-timeline-stage" style={{ minHeight: timelineHeight }}>
        <svg
          className="video-timeline-svg"
          viewBox={`0 0 1000 ${timelineHeight}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <rect className="timeline-background" x="0" y="0" width="1000" height={timelineHeight} rx="8" />
          {lanes.map(({ span, lane }) => {
            const left = timelinePercent(span.start_ms, durationMs) * 10;
            const right = timelinePercent(span.end_ms, durationMs) * 10;
            return (
              <rect
                className="timeline-asr-rect"
                data-testid={`timeline-asr-${span.evidence_id}`}
                key={span.evidence_id}
                x={left}
                y={lane * LANE_HEIGHT + 3}
                width={Math.max(right - left, 2)}
                height={LANE_HEIGHT - 6}
                rx="4"
              />
            );
          })}
          {frames.map((frame) => (
            <line
              className={frame.original_frame_id === selectedFrameId ? 'timeline-frame-line is-selected' : 'timeline-frame-line'}
              key={frame.original_frame_id}
              x1={timelinePercent(frame.timestamp_ms, durationMs) * 10}
              x2={timelinePercent(frame.timestamp_ms, durationMs) * 10}
              y1={Math.max(0, timelineHeight - FRAME_TRACK_HEIGHT)}
              y2={timelineHeight}
            />
          ))}
          <line
            className="timeline-playhead"
            x1={playhead * 10}
            x2={playhead * 10}
            y1="0"
            y2={timelineHeight}
          />
        </svg>

        <div className="timeline-asr-hit-layer">
          {lanes.map(({ span, lane }) => (
            <button
              className="timeline-asr-hit"
              key={span.evidence_id}
              type="button"
              aria-label={`ASR: ${span.text}`}
              title={`${span.text} · ${formatMs(span.start_ms)}–${formatMs(span.end_ms)}`}
              style={{
                left: `${timelinePercent(span.start_ms, durationMs)}%`,
                width: `${Math.max(timelinePercent(span.end_ms, durationMs) - timelinePercent(span.start_ms, durationMs), 0.8)}%`,
                top: lane * LANE_HEIGHT + 3,
              }}
              onClick={() => onSeek(span.start_ms)}
            >
              <span>{span.text}</span>
            </button>
          ))}
        </div>

        <div className="timeline-frame-hit-layer">
          {frames.map((frame) => (
            <button
              className={frame.original_frame_id === selectedFrameId ? 'timeline-frame-hit is-selected' : 'timeline-frame-hit'}
              key={frame.original_frame_id}
              type="button"
              aria-label={`Frame ${frame.original_frame_id} tại ${formatMs(frame.timestamp_ms)}`}
              title={`Frame ${frame.original_frame_id} · ${formatMs(frame.timestamp_ms)}`}
              style={{ left: `${timelinePercent(frame.timestamp_ms, durationMs)}%` }}
              onClick={() => {
                onFrameSelect(frame);
                onSeek(frame.timestamp_ms);
              }}
            />
          ))}
        </div>
      </div>

      <label className="timeline-scrubber">
        <span className="sr-only">Tua video</span>
        <input
          aria-label="Vị trí video"
          type="range"
          min="0"
          max={Math.max(durationMs, 1)}
          step="1"
          value={Math.max(0, Math.min(durationMs, currentTimeMs))}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </label>
      <div className="timeline-footer">
        <span>{formatMs(Math.max(0, currentTimeMs))}</span>
        <span>{formatMs(Math.max(0, durationMs))}</span>
      </div>
    </section>
  );
}

function assignAsrLanes(spans: readonly StudioAsrSpan[]): AsrLane[] {
  const laneEnds = Array.from({ length: MAX_ASR_LANES }, () => 0);
  return [...spans]
    .sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms || left.evidence_id.localeCompare(right.evidence_id))
    .map((span) => {
      const availableLane = laneEnds.findIndex((endMs) => endMs <= span.start_ms);
      const lane = availableLane >= 0
        ? availableLane
        : laneEnds.reduce((earliestLane, endMs, index) => endMs < laneEnds[earliestLane] ? index : earliestLane, 0);
      laneEnds[lane] = Math.max(laneEnds[lane], span.end_ms);
      return { span, lane };
    });
}
