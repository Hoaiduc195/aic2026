'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { CanonicalFrameResponse, StudioFrame, VideoStudioResponse } from '../../lib/contracts';
import { activeAsrSpans, keyframeLabel, nearestStudioFrame, studioFrameThumbnailUri } from '../../lib/video-studio-model';
import { formatMs } from '../../lib/workbench-model';
import { VideoTimelineOverlay } from './VideoTimelineOverlay';

interface Props {
  studio: VideoStudioResponse;
  initialFrameId: number;
  initialTimestampMs?: number;
  onClose: () => void;
  onSelectFrame: (frame: StudioFrame) => void;
  loadExactFrame?: (frameId: number, signal?: AbortSignal) => Promise<CanonicalFrameResponse>;
}

export function VideoStudioModal({
  studio,
  initialFrameId,
  initialTimestampMs = 0,
  onClose,
  onSelectFrame,
  loadExactFrame,
}: Props) {
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
  const [exactFrame, setExactFrame] = useState<CanonicalFrameResponse | null>(null);
  const [frameIdInput, setFrameIdInput] = useState(String(initialFrameId));
  const [isLoadingExactFrame, setIsLoadingExactFrame] = useState(false);
  const [exactFrameError, setExactFrameError] = useState<string | null>(null);
  const selectedFrame = exactFrame
    ?? studio.frames.find((frame) => frame.original_frame_id === selectedFrameId)
    ?? initialFrame
    ?? null;
  const maxFrameId = studio.video.frame_count === undefined || studio.video.frame_count === null
    ? 2_147_483_647
    : Math.max(0, studio.video.frame_count - 1);
  const currentVideoFrameId = Math.max(
    0,
    Math.min(
      maxFrameId,
      Math.round((currentTimeMs / 1000) * Math.max(0, studio.video.fps)),
    ),
  );
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
    setFrameIdInput(String(initialFrameId));
    setExactFrame(null);
    setExactFrameError(null);
  }, [initialFrame?.original_frame_id, initialFrame?.timestamp_ms, initialFrameId]);

  useEffect(() => {
    if (!loadExactFrame || initialFrameId < 0 || studio.frames.some((frame) => frame.original_frame_id === initialFrameId)) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setIsLoadingExactFrame(true);
    setExactFrameError(null);
    void loadExactFrame(initialFrameId, controller.signal)
      .then((frame) => {
        if (cancelled) return;
        setExactFrame(frame);
        setSelectedFrameId(frame.original_frame_id);
        setCurrentTimeMs(frame.timestamp_ms);
      })
      .catch(() => {
        if (!cancelled) setExactFrameError('Không tải được canonical frame này.');
      })
      .finally(() => {
        if (!cancelled) setIsLoadingExactFrame(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [initialFrameId, loadExactFrame, studio.frames]);

  function seek(timestampMs: number, clearExact = true) {
    const clamped = Math.max(0, Math.min(studio.video.duration_ms, timestampMs));
    if (clearExact) setExactFrame(null);
    setCurrentTimeMs(clamped);
    const frame = nearestStudioFrame(studio.frames, clamped);
    if (frame) setSelectedFrameId(frame.original_frame_id);
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
  }

  function selectFrame(frame: StudioFrame) {
    setExactFrame(null);
    setExactFrameError(null);
    setSelectedFrameId(frame.original_frame_id);
    seek(frame.timestamp_ms);
  }

  function handleTimeUpdate() {
    const timestampMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    setCurrentTimeMs(timestampMs);
    if (!exactFrame || Math.abs(timestampMs - exactFrame.timestamp_ms) > 50) setExactFrame(null);
    const frame = nearestStudioFrame(studio.frames, timestampMs);
    if (frame) setSelectedFrameId(frame.original_frame_id);
  }

  async function loadAndSelectExactFrame(frameId: number) {
    if (!loadExactFrame) return;
    setIsLoadingExactFrame(true);
    setExactFrameError(null);
    try {
      const frame = await loadExactFrame(frameId);
      setExactFrame(frame);
      setSelectedFrameId(frame.original_frame_id);
      setCurrentTimeMs(frame.timestamp_ms);
      if (videoRef.current) videoRef.current.currentTime = frame.timestamp_ms / 1000;
    } catch {
      setExactFrameError('Không tải được canonical frame. Hãy kiểm tra frame ID và kết nối backend.');
    } finally {
      setIsLoadingExactFrame(false);
    }
  }

  async function chooseExactFrame() {
    if (!loadExactFrame) return;
    const rawFrameId = frameIdInput.trim();
    const frameId = Number(rawFrameId);
    if (!rawFrameId || !Number.isInteger(frameId) || frameId < 0 || frameId > maxFrameId) {
      setExactFrameError(`Frame ID phải là số nguyên từ 0 đến ${maxFrameId}.`);
      return;
    }

    await loadAndSelectExactFrame(frameId);
  }

  async function chooseCurrentVideoFrame() {
    if (!loadExactFrame) return;
    setFrameIdInput(String(currentVideoFrameId));
    await loadAndSelectExactFrame(currentVideoFrameId);
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
            <span>{studio.frames.length} {studio.frames.length === 1 ? 'keyframe' : 'keyframes'}</span>
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
                onLoadedMetadata={() => seek(currentTimeMs, false)}
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

            <div className="video-studio-exact-picker" aria-label="Chọn canonical frame chính xác">
              <div>
                <p className="eyebrow">Canonical frame</p>
                <label htmlFor="studio-exact-frame-id">Frame ID trong video</label>
              </div>
              <div className="video-studio-exact-picker-controls">
                <input
                  id="studio-exact-frame-id"
                  type="number"
                  min={0}
                  max={studio.video.frame_count === undefined || studio.video.frame_count === null ? undefined : Math.max(0, studio.video.frame_count - 1)}
                  step={1}
                  inputMode="numeric"
                  value={frameIdInput}
                  onChange={(event) => setFrameIdInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void chooseExactFrame();
                  }}
                  aria-describedby="studio-exact-frame-help"
                />
                <button type="button" className="secondary-button" onClick={() => void chooseExactFrame()} disabled={!loadExactFrame || isLoadingExactFrame}>
                  {isLoadingExactFrame ? 'Đang tải…' : 'Tải exact frame'}
                </button>
                <button type="button" className="secondary-button" onClick={() => void chooseCurrentVideoFrame()} disabled={!loadExactFrame || isLoadingExactFrame}>
                  Chọn frame hiện tại
                </button>
              </div>
              <small id="studio-exact-frame-help">
                Nhập số frame nguồn để xem đúng frame, kể cả khi frame đó không nằm trong danh sách keyframe thưa.
              </small>
              {exactFrameError && <p className="inline-error" role="alert">{exactFrameError}</p>}
            </div>

            <div className="video-studio-filmstrip" aria-label="Các canonical keyframe trong video">
              {studio.frames.map((frame) => (
                <button
                  type="button"
                  key={frame.original_frame_id}
                  className={frame.original_frame_id === selectedFrameId ? 'studio-filmstrip-frame is-selected' : 'studio-filmstrip-frame'}
                  aria-label={`Chọn ${keyframeLabel(frame).toLowerCase()}`}
                  aria-pressed={frame.original_frame_id === selectedFrameId}
                  onClick={() => selectFrame(frame)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={studioFrameThumbnailUri(frame)}
                    alt={`${keyframeLabel(frame)} của ${frame.video_id}`}
                    loading={frame.original_frame_id === selectedFrameId ? 'eager' : 'lazy'}
                    decoding="async"
                  />
                  <span>{frame.keyframe_no === null || frame.keyframe_no === undefined ? 'Exact frame' : `#${frame.keyframe_no}`}</span>
                  <small>Source frame {frame.original_frame_id} · {formatMs(frame.timestamp_ms)}</small>
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
                    <h3>{selectedFrame.is_exact_frame ? `Canonical frame ${selectedFrame.original_frame_id}` : `Keyframe ${selectedFrame.keyframe_no}`}</h3>
                  </div>
                  <span>Source frame {selectedFrame.original_frame_id} · {formatMs(selectedFrame.timestamp_ms)}</span>
                </div>

                {selectedFrame.is_exact_frame
                  && selectedFrame.annotation_source_frame_id !== null
                  && selectedFrame.annotation_source_frame_id !== undefined
                  && selectedFrame.annotation_source_frame_id !== selectedFrame.original_frame_id && (
                    <p className="studio-annotation-note">
                      Annotation đang hiển thị lấy từ frame gần nhất có dữ liệu: {selectedFrame.annotation_source_frame_id}.
                    </p>
                  )}

                <div className="studio-frame-canvas">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    data-testid="studio-selected-frame-image"
                    src={studioFrameThumbnailUri(selectedFrame)}
                    alt={`${keyframeLabel(selectedFrame)} của ${selectedFrame.video_id}`}
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
                            strokeWidth="0.014"
                          />
                          <text
                            x={object.normalized_bbox[0]}
                            y={Math.max(0.06, object.normalized_bbox[1] - 0.01)}
                            fontSize="0.045"
                            fontWeight="400"
                            stroke="#071018"
                            strokeWidth="0.008"
                            paintOrder="stroke"
                          >
                            {object.label}
                          </text>
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
                    {selectedFrame.is_exact_frame
                      ? `Chọn frame đại diện (canonical frame ${selectedFrame.original_frame_id})`
                      : `Chọn frame đại diện (keyframe ${selectedFrame.keyframe_no})`}
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
