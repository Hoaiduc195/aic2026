'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { StudioFrame, VideoStudioResponse } from '../../lib/contracts';
import { activeAsrSpans, frameThumbnailUri, nearestStudioFrame } from '../../lib/video-studio-model';
import { formatMs } from '../../lib/workbench-model';
import { VideoTimelineOverlay } from './VideoTimelineOverlay';

interface Props {
  studio: VideoStudioResponse;
  initialFrameId: number;
  initialTimestampMs?: number;
  onClose: () => void;
  onSelectFrame: (frame: StudioFrame) => void;
}

export function VideoStudioModal({ studio, initialFrameId, initialTimestampMs = 0, onClose, onSelectFrame }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const initialFrame = useMemo(
    () => studio.frames.find((frame) => frame.original_frame_id === initialFrameId)
      ?? nearestStudioFrame(studio.frames, initialTimestampMs),
    [initialFrameId, initialTimestampMs, studio.frames],
  );
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(initialFrame?.original_frame_id ?? null);
  const [currentTimeMs, setCurrentTimeMs] = useState(initialFrame?.timestamp_ms ?? 0);
  const [showBoxes, setShowBoxes] = useState(true);
  const selectedFrame = studio.frames.find((frame) => frame.original_frame_id === selectedFrameId) ?? initialFrame ?? null;
  const activeSpans = useMemo(
    () => activeAsrSpans(studio.asr_spans, currentTimeMs),
    [currentTimeMs, studio.asr_spans],
  );

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    setSelectedFrameId(initialFrame?.original_frame_id ?? null);
    setCurrentTimeMs(initialFrame?.timestamp_ms ?? 0);
  }, [initialFrame?.original_frame_id, initialFrame?.timestamp_ms]);

  function seek(timestampMs: number) {
    const clamped = Math.max(0, Math.min(studio.video.duration_ms, timestampMs));
    setCurrentTimeMs(clamped);
    const frame = nearestStudioFrame(studio.frames, clamped);
    if (frame) setSelectedFrameId(frame.original_frame_id);
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
  }

  function selectFrame(frame: StudioFrame) {
    setSelectedFrameId(frame.original_frame_id);
    seek(frame.timestamp_ms);
  }

  function handleTimeUpdate() {
    const timestampMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    setCurrentTimeMs(timestampMs);
    const frame = nearestStudioFrame(studio.frames, timestampMs);
    if (frame) setSelectedFrameId(frame.original_frame_id);
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Tab' && event.shiftKey && document.activeElement === dialogRef.current) {
      event.preventDefault();
    }
  }

  return (
    <div className="video-studio-backdrop">
      <div
        ref={dialogRef}
        className="video-studio-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Video studio ${studio.video.video_id}`}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="video-studio-header">
          <div>
            <p className="eyebrow">Video evidence studio</p>
            <h2 id="video-studio-title">{studio.video.video_id}</h2>
          </div>
          <div className="video-studio-header-meta">
            <span>{formatMs(studio.video.duration_ms)}</span>
            <button type="button" className="icon-button" aria-label="Đóng video studio" onClick={onClose}>×</button>
          </div>
        </header>

        <div className="video-studio-body">
          <section className="video-studio-main" aria-label="Trình chỉnh sửa video">
            <div className="video-studio-player">
              <video
                ref={videoRef}
                controls
                preload="metadata"
                src={studio.video.playback_uri}
                aria-label={`Video ${studio.video.video_id}`}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={() => seek(currentTimeMs)}
              />
            </div>

            <VideoTimelineOverlay
              durationMs={studio.video.duration_ms}
              currentTimeMs={currentTimeMs}
              frames={studio.frames}
              asrSpans={studio.asr_spans}
              selectedFrameId={selectedFrameId}
              onSeek={seek}
              onFrameSelect={selectFrame}
            />

            <div className="video-studio-filmstrip" aria-label="Các canonical frame trong video">
              {studio.frames.map((frame) => (
                <button
                  type="button"
                  key={frame.original_frame_id}
                  className={frame.original_frame_id === selectedFrameId ? 'studio-filmstrip-frame is-selected' : 'studio-filmstrip-frame'}
                  aria-label={`Chọn frame ${frame.original_frame_id}`}
                  aria-pressed={frame.original_frame_id === selectedFrameId}
                  onClick={() => selectFrame(frame)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={frameThumbnailUri(frame.video_id, frame.original_frame_id)}
                    alt={`Frame ${frame.original_frame_id} của ${frame.video_id}`}
                    loading={frame.original_frame_id === selectedFrameId ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                  <span>#{frame.original_frame_id}</span>
                  <small>{formatMs(frame.timestamp_ms)}</small>
                </button>
              ))}
            </div>
          </section>

          <aside className="video-studio-inspector" aria-label="Thông tin frame đang chọn">
            {selectedFrame ? (
              <>
                <div className="studio-selection-heading">
                  <div>
                    <p className="eyebrow">Frame đang chọn</p>
                    <h3>Frame {selectedFrame.original_frame_id}</h3>
                  </div>
                  <span>{formatMs(selectedFrame.timestamp_ms)}</span>
                </div>

                <div className="studio-frame-canvas">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    data-testid="studio-selected-frame-image"
                    src={frameThumbnailUri(selectedFrame.video_id, selectedFrame.original_frame_id)}
                    alt={`Frame ${selectedFrame.original_frame_id} của ${selectedFrame.video_id}`}
                    loading="eager"
                    decoding="async"
                  />
                  {showBoxes && (
                    <svg className="studio-object-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Bounding box object">
                      {selectedFrame.objects.map((object) => object.normalized_bbox && (
                        <g key={object.evidence_id} data-testid={`studio-object-box-${object.evidence_id}`}>
                          <rect
                            x={object.normalized_bbox[0]}
                            y={object.normalized_bbox[1]}
                            width={Math.max(0, object.normalized_bbox[2] - object.normalized_bbox[0])}
                            height={Math.max(0, object.normalized_bbox[3] - object.normalized_bbox[1])}
                          />
                          <text x={object.normalized_bbox[0]} y={Math.max(0.04, object.normalized_bbox[1] - 0.01)}>{object.label}</text>
                        </g>
                      ))}
                    </svg>
                  )}
                </div>

                <div className="studio-toolbar">
                  <button type="button" className="secondary-button" onClick={() => setShowBoxes((visible) => !visible)}>
                    {showBoxes ? 'Ẩn bounding box' : 'Hiện bounding box'}
                  </button>
                  <button type="button" className="primary-button" onClick={() => { onSelectFrame(selectedFrame); onClose(); }}>
                    Dùng frame {selectedFrame.original_frame_id}
                  </button>
                </div>

                <section className="studio-evidence-section">
                  <h4>Caption</h4>
                  {selectedFrame.captions.length > 0 ? selectedFrame.captions.map((caption) => (
                    <article className="studio-evidence-card" key={caption.evidence_id}>
                      <p>{caption.text}</p>
                      <small>{caption.language} · {caption.producer}</small>
                    </article>
                  )) : <p className="muted-copy">Frame này chưa có caption.</p>}
                </section>

                <section className="studio-evidence-section">
                  <h4>Objects · {selectedFrame.objects.length}</h4>
                  {selectedFrame.objects.length > 0 ? selectedFrame.objects.map((object) => (
                    <article className="studio-object-row" key={object.evidence_id}>
                      <span>{object.label}</span>
                      <small>{Math.round(object.confidence * 100)}%</small>
                    </article>
                  )) : <p className="muted-copy">Frame này chưa có object detection.</p>}
                </section>

                <section className="studio-evidence-section">
                  <h4>ASR đang phủ lên frame · {activeSpans.length}</h4>
                  {activeSpans.length > 0 ? activeSpans.map((span) => (
                    <article className="studio-evidence-card studio-asr-card" key={span.evidence_id}>
                      <p>{span.text}</p>
                      <small>{formatMs(span.start_ms)}–{formatMs(span.end_ms)} · {span.producer}</small>
                    </article>
                  )) : <p className="muted-copy">Timestamp này không nằm trong ASR span nào.</p>}
                </section>
              </>
            ) : (
              <p className="muted-copy">Video này chưa có canonical frame.</p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
