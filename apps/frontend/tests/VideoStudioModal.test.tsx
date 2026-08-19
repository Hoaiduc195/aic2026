import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { VideoStudioModal } from '@/components/workbench/VideoStudioModal';
import type { CanonicalFrameResponse, VideoStudioResponse } from '@/lib/contracts';

const studio: VideoStudioResponse = {
  video: {
    video_id: 'video-1', playback_uri: 'https://media.example/video.mp4',
    duration_ms: 60_000, fps: 25, mime_type: 'video/mp4',
    frame_count: 1_500,
  },
  frames: [
    {
      video_id: 'video-1', keyframe_no: 1, original_frame_id: 50, timestamp_ms: 2_000,
      captions: [{ evidence_id: 'caption-1', text: 'Một cảnh trong studio.', language: 'en', producer: 'caption:v1' }],
      objects: [{ evidence_id: 'object-1', label: 'person', confidence: 0.92, normalized_bbox: [0.1, 0.2, 0.3, 0.4], producer: 'object:v1' }],
    },
  ],
  asr_spans: [{ evidence_id: 'asr-1', start_ms: 1_000, end_ms: 3_000, text: 'Xin chào', language: 'vi', producer: 'asr:v1' }],
};

describe('VideoStudioModal', () => {
  it('shows selected frame annotations and supports selecting the frame for the workbench', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelectFrame = vi.fn();

    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        onClose={onClose}
        onSelectFrame={onSelectFrame}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Video studio video-1' })).toBeInTheDocument();
    expect(screen.getByText(/1\s+keyframe/)).toBeInTheDocument();
    expect(screen.getByText('Keyframe 1')).toBeInTheDocument();
    expect(screen.getAllByText(/Source frame\s+50/).length).toBeGreaterThan(0);
    expect(screen.getByText('Một cảnh trong studio.')).toBeInTheDocument();
    expect(screen.getAllByText('person').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Xin chào').length).toBeGreaterThan(0);
    const objectBox = screen.getByTestId('studio-object-box-object-1');
    expect(objectBox).toBeInTheDocument();
    expect(objectBox.querySelector('rect')).toHaveAttribute('stroke-width', '0.014');
    expect(objectBox.querySelector('text')).toHaveAttribute('font-size', '0.045');
    expect(objectBox.querySelector('text')).toHaveAttribute('font-weight', '400');

    await user.click(screen.getByRole('button', { name: 'Dùng keyframe 1' }));
    expect(onSelectFrame).toHaveBeenCalledWith(studio.frames[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('marks filmstrip thumbnails as lazy while prioritizing the selected frame', () => {
    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        onClose={vi.fn()}
        onSelectFrame={vi.fn()}
      />,
    );

    expect(screen.getByTestId('studio-selected-frame-image')).toHaveAttribute('loading', 'eager');
    expect(screen.getByRole('button', { name: 'Chọn keyframe 1 · source frame 50' })).toBeInTheDocument();
  });

  it('loads an exact canonical frame and updates its annotations before selection', async () => {
    const user = userEvent.setup();
    const exactFrame: CanonicalFrameResponse = {
      video_id: 'video-1',
      keyframe_no: null,
      original_frame_id: 77,
      timestamp_ms: 3_080,
      thumbnail_uri: '/api/v1/media/videos/video-1/frames/77/thumbnail',
      is_exact_frame: true,
      annotation_source_frame_id: 50,
      captions: [{ evidence_id: 'caption-exact', text: 'Exact frame caption.', language: 'en', producer: 'caption:v1' }],
      objects: [{ evidence_id: 'object-exact', label: 'car', confidence: 0.88, normalized_bbox: [0.2, 0.2, 0.5, 0.5], producer: 'object:v1' }],
    };
    const loadExactFrame = vi.fn(async () => exactFrame);
    const onSelectFrame = vi.fn();

    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        onClose={vi.fn()}
        onSelectFrame={onSelectFrame}
        loadExactFrame={loadExactFrame}
      />,
    );

    const input = screen.getByLabelText('Frame ID trong video');
    await user.clear(input);
    await user.type(input, '77');
    await user.click(screen.getByRole('button', { name: 'Tải exact frame' }));

    expect(loadExactFrame).toHaveBeenCalledWith(77);
    expect(await screen.findByText('Canonical frame 77')).toBeInTheDocument();
    expect(screen.getByText('Exact frame caption.')).toBeInTheDocument();
    expect(screen.getAllByText('car').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Annotation đang hiển thị lấy từ frame gần nhất.*50/)).toBeInTheDocument();
    expect(screen.getByTestId('studio-selected-frame-image')).toHaveAttribute('src', exactFrame.thumbnail_uri);

    await user.click(screen.getByRole('button', { name: 'Dùng canonical frame 77' }));
    expect(onSelectFrame).toHaveBeenCalledWith(exactFrame);
  });
});
