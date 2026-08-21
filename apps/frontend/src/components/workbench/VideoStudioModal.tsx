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
  onSelectFrame?: (frame: StudioFrame) => void;
  onSelectFrames?: (frames: readonly StudioFrame[]) => void;
  selectionMode?: 'single' | 'multiple';
  initialSelectedFrameIds?: readonly number[];
  loadExactFrame?: (frameId: number, signal?: AbortSignal) => Promise<CanonicalFrameResponse>;
}

function sourceFrameIdAtTime(timestampSeconds: number, fps: number, lastFrameId: number): number {
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(lastFrameId, Math.floor((timestampSeconds * fps) + Number.EPSILON)));
}

export function VideoStudioModal({
  studio,
  initialFrameId,
  initialTimestampMs = 0,
  onClose,
  onSelectFrame,
  onSelectFrames,
  selectionMode = 'single',
  initialSelectedFrameIds = [],
  loadExactFrame,
}: Props) {
  const isMultiSelect = selectionMode === 'multiple';
  const selectedFrameIdsKey = initialSelectedFrameIds.join(',');
  const initialFrameIds = useMemo(
    () => selectedFrameIdsKey ? selectedFrameIdsKey.split(',').map(Number) : [],
    [selectedFrameIdsKey],
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pendingExactFrameSeekRef = useRef<number | null>(null);
  const initialFrame = useMemo(
    () => studio.frames.find((frame) => frame.original_frame_id === initialFrameId)
      ?? nearestStudioFrame(studio.frames, initialTimestampMs),
    [initialFrameId, initialTimestampMs, studio.frames],
  );
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(initialFrame?.original_frame_id ?? null);
  const [currentTimeMs, setCurrentTimeMs] = useState(initialFrame?.timestamp_ms ?? 0);
  const [showBoxes, setShowBoxes] = useState(true);
  const [exactFrame, setExactFrame] = useState<CanonicalFrameResponse | null>(null);
  const [selectedFrameOverride, setSelectedFrameOverride] = useState<StudioFrame | null>(null);
  const [selectedFrames, setSelectedFrames] = useState<StudioFrame[]>(() => (
    initialFrameIds
      .map((frameId) => studio.frames.find((frame) => frame.original_frame_id === frameId))
      .filter((frame): frame is StudioFrame => frame !== undefined)
      .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
  ));
  const [targetSlotIndex, setTargetSlotIndex] = useState<number | null>(null);
  const [isLoadingExactFrame, setIsLoadingExactFrame] = useState(false);
  const [exactFrameError, setExactFrameError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectedFrame = selectedFrameOverride
    ?? exactFrame
    ?? studio.frames.find((frame) => frame.original_frame_id === selectedFrameId)
    ?? initialFrame
    ?? null;
  const orderedSelectedFrames = useMemo(
    () => [...selectedFrames].sort((left, right) => (
      left.timestamp_ms - right.timestamp_ms || left.original_frame_id - right.original_frame_id
    )),
    [selectedFrames],
  );
  const selectionIsValid = orderedSelectedFrames.length === 4
    && orderedSelectedFrames.every((frame, index) => (
      index === 0 || orderedSelectedFrames[index - 1].timestamp_ms < frame.timestamp_ms
    ));
  const lastFrameId = studio.video.frame_count === undefined || studio.video.frame_count === null
    ? 2_147_483_647
    : Math.max(0, studio.video.frame_count - 1);
  const currentVideoFrameId = Math.max(
    0,
    sourceFrameIdAtTime(currentTimeMs / 1000, studio.video.fps, lastFrameId),
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
    setExactFrame(null);
    setSelectedFrameOverride(null);
    setExactFrameError(null);
    pendingExactFrameSeekRef.current = null;
  }, [initialFrame?.original_frame_id, initialFrame?.timestamp_ms, initialFrameId]);

  useEffect(() => {
    if (!isMultiSelect) {
      setSelectedFrames([]);
      setTargetSlotIndex(null);
      return;
    }
    setSelectedFrames(initialFrameIds
      .map((frameId) => studio.frames.find((frame) => frame.original_frame_id === frameId))
      .filter((frame): frame is StudioFrame => frame !== undefined)
      .sort((left, right) => left.timestamp_ms - right.timestamp_ms)
      .slice(0, 4));
    setTargetSlotIndex(null);
    setSelectionError(null);
  }, [initialFrameIds, selectedFrameIdsKey, isMultiSelect, studio.frames]);

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
    if (clearExact) {
      pendingExactFrameSeekRef.current = null;
      setExactFrame(null);
      setSelectedFrameOverride(null);
    }
    setCurrentTimeMs(clamped);
    const frame = nearestStudioFrame(studio.frames, clamped);
    if (frame) setSelectedFrameId(frame.original_frame_id);
    if (videoRef.current) videoRef.current.currentTime = clamped / 1000;
  }

  function selectFrame(frame: StudioFrame) {
    setExactFrame(null);
    setExactFrameError(null);
    setSelectionError(null);
    setSelectedFrameOverride(frame);
    setSelectedFrameId(frame.original_frame_id);
    seek(frame.timestamp_ms);
  }

  function handleTimeUpdate() {
    const timestampMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    setCurrentTimeMs(timestampMs);
    const isPendingExactFrameSeek = exactFrame !== null
      && pendingExactFrameSeekRef.current === exactFrame.original_frame_id;
    if (isPendingExactFrameSeek) {
      pendingExactFrameSeekRef.current = null;
    } else if (!exactFrame || Math.abs(timestampMs - exactFrame.timestamp_ms) > 50) {
      setExactFrame(null);
      setSelectedFrameOverride(null);
    }
    const frame = nearestStudioFrame(studio.frames, timestampMs);
    if (frame) setSelectedFrameId(frame.original_frame_id);
  }

  async function loadCurrentVideoFrame(frameId: number): Promise<CanonicalFrameResponse | null> {
    if (!loadExactFrame) return null;
    setIsLoadingExactFrame(true);
    setExactFrameError(null);
    try {
      const frame = await loadExactFrame(frameId);
      pendingExactFrameSeekRef.current = frame.original_frame_id;
      setExactFrame(frame);
      setSelectedFrameOverride(null);
      setSelectedFrameId(frame.original_frame_id);
      setCurrentTimeMs(frame.timestamp_ms);
      if (videoRef.current) videoRef.current.currentTime = frame.timestamp_ms / 1000;
      return frame;
    } catch {
      setExactFrameError('Không tải được frame tại vị trí đang dừng. Hãy kiểm tra kết nối backend.');
      return null;
    } finally {
      setIsLoadingExactFrame(false);
    }
  }

  async function chooseCurrentVideoFrame() {
    if (!loadExactFrame) return;
    const video = videoRef.current;
    const videoHasMetadata = (video?.readyState ?? 0) >= 1;
    const playheadTimeSeconds = videoHasMetadata && Number.isFinite(video?.currentTime)
      ? video.currentTime
      : currentTimeMs / 1000;
    const frameId = sourceFrameIdAtTime(playheadTimeSeconds, studio.video.fps, lastFrameId);
    const frame = await loadCurrentVideoFrame(frameId);
    if (!frame) return;
    if (!isMultiSelect) {
      onSelectFrame?.(frame);
      onClose();
      return;
    }
    addFrameToSelection(frame);
  }

  function addFrameToSelection(frame: StudioFrame) {
    const existingIndex = selectedFrames.findIndex((item) => item.original_frame_id === frame.original_frame_id);
    const slotIndex = targetSlotIndex ?? (selectedFrames.length < 4 ? selectedFrames.length : null);
    if (existingIndex >= 0 && existingIndex !== slotIndex) {
      setSelectionError(`Frame ${frame.original_frame_id} đã có trong bộ 4.`);
      return;
    }
    if (slotIndex === null) {
      setSelectionError('Bộ 4 đã đủ frame. Hãy chọn một slot để thay thế.');
      return;
    }
    setSelectedFrames((current) => {
      const next = [...current];
      next[slotIndex] = frame;
      return next.sort((left, right) => (
        left.timestamp_ms - right.timestamp_ms || left.original_frame_id - right.original_frame_id
      ));
    });
    setTargetSlotIndex(null);
    setSelectionError(null);
  }

  function addCurrentFrameToSelection() {
    if (!isMultiSelect || !selectedFrame) return;
    addFrameToSelection(selectedFrame);
  }

  function removeSelectedFrame(index: number) {
    setSelectedFrames((current) => current.filter((_, frameIndex) => frameIndex !== index));
    setTargetSlotIndex(null);
    setSelectionError(null);
  }

  function focusSelectedFrame(frame: StudioFrame, index: number) {
    setTargetSlotIndex(index);
    setSelectedFrameOverride(frame);
    setExactFrame(null);
    setExactFrameError(null);
    setSelectedFrameId(frame.original_frame_id);
    setCurrentTimeMs(frame.timestamp_ms);
    if (videoRef.current) videoRef.current.currentTime = frame.timestamp_ms / 1000;
  }

  function confirmSelection() {
    if (!isMultiSelect) return;
    if (!selectionIsValid || !onSelectFrames) {
      setSelectionError('TRAKE cần đúng 4 frame khác nhau, tăng dần theo thời gian.');
      return;
    }
    onSelectFrames(orderedSelectedFrames);
    onClose();
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

            <div className="video-studio-exact-picker" aria-label="Chọn frame tại vị trí đang dừng">
              <div>
                <p className="eyebrow">Frame đại diện</p>
                <span>Playhead hiện tại · frame {currentVideoFrameId} · {formatMs(currentTimeMs)}</span>
              </div>
              <div className="video-studio-exact-picker-controls">
                <button type="button" className="secondary-button" onClick={() => void chooseCurrentVideoFrame()} disabled={!loadExactFrame || isLoadingExactFrame}>
                  {isLoadingExactFrame ? 'Đang tải…' : isMultiSelect ? 'Tải frame hiện tại' : 'Chọn frame hiện tại'}
                </button>
              </div>
              <small>
                Tua hoặc dừng video tại khoảnh khắc cần nộp, sau đó tải đúng frame đang nằm dưới playhead.
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

            {isMultiSelect && (
              <section className="studio-selected-set" aria-label="Bộ 4 frame đã chọn">
                <div className="studio-selected-set-heading">
                  <div>
                    <p className="eyebrow">TRAKE</p>
                    <h3>Bộ 4 frame đã chọn</h3>
                  </div>
                  <strong>{orderedSelectedFrames.length}/4 frame đã chọn</strong>
                </div>
                <div className="studio-selected-set-grid">
                  {Array.from({ length: 4 }, (_, index) => {
                    const frame = orderedSelectedFrames[index];
                    return frame ? (
                      <article className={targetSlotIndex === index ? 'studio-selected-slot is-target' : 'studio-selected-slot'} key={frame.original_frame_id}>
                        <button type="button" className="studio-selected-slot-preview" onClick={() => focusSelectedFrame(frame, index)} aria-label={`Chọn slot ${index + 1}, frame ${frame.original_frame_id}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={studioFrameThumbnailUri(frame)} alt={`Frame ${frame.original_frame_id}`} loading="lazy" decoding="async" />
                          <span>Slot {index + 1} · frame {frame.original_frame_id}</span>
                          <small>{formatMs(frame.timestamp_ms)} · {frame.objects.length > 0 ? frame.objects.map((object) => object.label).join(', ') : 'Không có object'}</small>
                        </button>
                        <button type="button" className="studio-selected-slot-remove" onClick={() => removeSelectedFrame(index)} aria-label={`Xóa frame ${frame.original_frame_id} khỏi bộ 4`}>×</button>
                      </article>
                    ) : (
                      <div className={targetSlotIndex === index ? 'studio-selected-slot is-empty is-target' : 'studio-selected-slot is-empty'} key={`empty-${index}`}>
                        <span>Slot {index + 1}</span>
                        <small>Chọn frame rồi thêm vào đây</small>
                      </div>
                    );
                  })}
                </div>
                <div className="studio-selected-set-actions">
                  <button type="button" className="primary-button" onClick={confirmSelection} disabled={!selectionIsValid}>
                    Xác nhận bộ 4 frame
                  </button>
                </div>
                {selectionError && <p className="inline-error" role="alert">{selectionError}</p>}
              </section>
            )}
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
                  {isMultiSelect ? (
                    <button type="button" className="primary-button" onClick={addCurrentFrameToSelection} disabled={selectedFrames.length >= 4 && targetSlotIndex === null}>
                      {targetSlotIndex !== null
                        ? `Thay frame vào slot ${targetSlotIndex + 1}`
                        : selectedFrames.length < 4
                          ? 'Thêm frame đang xem vào bộ 4'
                          : 'Chọn slot để thay frame'}
                    </button>
                  ) : (
                    <button type="button" className="primary-button" onClick={() => { onSelectFrame?.(selectedFrame); onClose(); }}>
                      {selectedFrame.is_exact_frame
                        ? `Chọn frame đại diện (canonical frame ${selectedFrame.original_frame_id})`
                        : `Chọn frame đại diện (keyframe ${selectedFrame.keyframe_no})`}
                    </button>
                  )}
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
