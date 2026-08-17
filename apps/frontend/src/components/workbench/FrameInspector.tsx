'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import type {
  FrameCandidate,
  QualificationEventInput,
  QualificationTask,
  SearchEvidence,
  VideoFrame,
  VideoFramesResponse,
  VideoPlayback,
} from '../../lib/contracts';
import { displayMatchedModalities, formatMs, groupEvidence } from '../../lib/workbench-model';

interface Props {
  task: QualificationTask;
  anchor: FrameCandidate;
  active: FrameCandidate;
  events: readonly QualificationEventInput[];
  assignedFrames: readonly (FrameCandidate | null)[];
  qaAnswer: string;
  loadPlayback: (videoId: string, frameId: number) => Promise<VideoPlayback>;
  loadFrames: (videoId: string, centerFrameId: number, limit: number) => Promise<VideoFramesResponse>;
  onClose: () => void;
  onFrameSelect: (frame: VideoFrame) => void;
  onQaAnswerChange: (value: string) => void;
  onSuggestVqaAnswer?: () => void;
  vqaAnswerLoading?: boolean;
  onAddAnswer: () => void;
  onAssignEvent: (index: number) => void;
}

const EVIDENCE_LABELS: ReadonlyArray<{
  key: 'ocr' | 'asr' | 'caption' | 'visual' | 'other';
  label: string;
}> = [
  { key: 'ocr', label: 'Văn bản trong hình (OCR)' },
  { key: 'asr', label: 'Lời thoại (ASR)' },
  { key: 'caption', label: 'Mô tả cảnh' },
  { key: 'visual', label: 'Bằng chứng hình ảnh' },
  { key: 'other', label: 'Bằng chứng khác' },
];

export function FrameInspector({
  task,
  anchor,
  active,
  events,
  assignedFrames,
  qaAnswer,
  loadPlayback,
  loadFrames,
  onClose,
  onFrameSelect,
  onQaAnswerChange,
  onSuggestVqaAnswer,
  vqaAnswerLoading = false,
  onAddAnswer,
  onAssignEvent,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [showFrames, setShowFrames] = useState(false);
  const evidence = useMemo(() => groupEvidence(active.evidence), [active.evidence]);
  const modalityLabel = displayMatchedModalities(active.matched_modalities);

  const playbackQuery = useQuery({
    queryKey: ['video-playback', anchor.video_id, anchor.original_frame_id],
    queryFn: () => loadPlayback(anchor.video_id, anchor.original_frame_id),
    enabled: false,
  });
  const framesQuery = useQuery({
    queryKey: ['video-frames', anchor.video_id, anchor.original_frame_id],
    queryFn: () => loadFrames(anchor.video_id, anchor.original_frame_id, 25),
    enabled: false,
  });

  useEffect(() => {
    setShowVideo(false);
    setShowFrames(false);
  }, [anchor.result_key]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextTime = active.timestamp_ms / 1000;
    if (Number.isFinite(nextTime)) video.currentTime = nextTime;
  }, [active.timestamp_ms, playbackQuery.data]);

  function requestVideo() {
    setShowVideo(true);
    void playbackQuery.refetch();
  }

  function requestFrames() {
    setShowFrames(true);
    void framesQuery.refetch();
  }

  return (
    <aside className="frame-inspector" aria-label="Chi tiết frame">
      <header className="inspector-heading">
        <div>
          <p>{active.video_id}</p>
          <h2>Frame {active.original_frame_id}</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Đóng chi tiết frame" onClick={onClose}>×</button>
      </header>

      <div className="inspector-media">
        {showVideo && playbackQuery.data ? (
          <video
            ref={videoRef}
            controls
            preload="metadata"
            aria-label={`Video ${active.video_id}`}
            src={playbackQuery.data.playback_uri}
            onLoadedMetadata={() => {
              if (videoRef.current) videoRef.current.currentTime = active.timestamp_ms / 1000;
            }}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={active.thumbnail_uri} alt={`Frame ${active.original_frame_id} của ${active.video_id}`} />
        )}
      </div>

      <div className="inspector-meta">
        <span>{formatMs(active.timestamp_ms)}</span>
        <span>Điểm {active.score.toFixed(3)}</span>
        <span>{modalityLabel || '—'}</span>
      </div>

      <div className="media-actions">
        <button type="button" className="secondary-button" disabled={playbackQuery.isFetching} onClick={requestVideo}>
          {playbackQuery.isFetching ? 'Đang tải video…' : 'Xem video'}
        </button>
        <button type="button" className="secondary-button" disabled={framesQuery.isFetching} onClick={requestFrames}>
          {framesQuery.isFetching ? 'Đang tải frame…' : 'Xem các frame cùng video'}
        </button>
      </div>
      {(playbackQuery.error || framesQuery.error) && (
        <p className="inline-error" role="alert">
          {readError(playbackQuery.error ?? framesQuery.error)}
        </p>
      )}

      {showFrames && framesQuery.data && (
        <section className="filmstrip" aria-label="Các frame cùng video">
          <div className="filmstrip-track">
            {framesQuery.data.frames.map((frame) => (
              <button
                type="button"
                key={`${frame.video_id}-${frame.original_frame_id}`}
                aria-label={`Chọn frame ${frame.original_frame_id}`}
                aria-pressed={active.original_frame_id === frame.original_frame_id}
                onClick={() => onFrameSelect(frame)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={frame.thumbnail_uri} alt="" loading="lazy" />
                <span>#{frame.original_frame_id}</span>
                <small>{formatMs(frame.timestamp_ms)}</small>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="answer-builder">
        <h3>{task === 'trake' ? 'Gán chuỗi sự kiện' : 'Tạo đáp án'}</h3>
        {task === 'qa' && (
          <label className="input-field compact-field">
            <span>Câu trả lời</span>
            <input
              aria-label="Câu trả lời"
              value={qaAnswer}
              maxLength={2000}
              placeholder="Nhập câu trả lời ngắn gọn…"
              onChange={(event) => onQaAnswerChange(event.target.value)}
            />
          </label>
        )}
        {task === 'qa' && (
          <button
            type="button"
            className="secondary-button full-width"
            disabled={!onSuggestVqaAnswer || vqaAnswerLoading}
            onClick={() => onSuggestVqaAnswer?.()}
          >
            {vqaAnswerLoading ? 'Đang hỏi LLM…' : 'Gợi ý answer bằng LLM'}
          </button>
        )}
        {task === 'trake' ? (
          <div className="event-assignments">
            {events.map((event, index) => (
              <div key={event.event_id}>
                <span><b>{index + 1}</b>{event.description}</span>
                <button type="button" onClick={() => onAssignEvent(index)}>
                  {assignedFrames[index] ? `Frame ${assignedFrames[index]?.original_frame_id}` : 'Gán frame hiện tại'}
                </button>
              </div>
            ))}
            <button type="button" className="primary-button full-width" onClick={onAddAnswer}>
              Thêm chuỗi vào đáp án
            </button>
          </div>
        ) : (
          <button type="button" className="primary-button full-width" onClick={onAddAnswer}>
            Thêm vào đáp án
          </button>
        )}
      </section>

      <section className="evidence-panel">
        <h3>Bằng chứng liên quan</h3>
        {EVIDENCE_LABELS.map(({ key, label }) => (
          evidence[key].length > 0 && <EvidenceBlock key={key} label={label} items={evidence[key]} />
        ))}
        {active.evidence.length === 0 && <p className="muted-copy">Frame này chưa có bằng chứng văn bản đi kèm.</p>}
      </section>
    </aside>
  );
}

function EvidenceBlock({ label, items }: { label: string; items: readonly SearchEvidence[] }) {
  return (
    <div className="evidence-block">
      <h4>{label}</h4>
      {items.map((item) => (
        <article key={item.evidence_id}>
          <p>{item.snippet || 'Không có nội dung trích xuất.'}</p>
          <small>{item.producer}</small>
        </article>
      ))}
    </div>
  );
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : 'Không thể tải dữ liệu media.';
}
