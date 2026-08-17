import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { VideoStudioModal } from '@/components/workbench/VideoStudioModal';
import type { VideoStudioResponse } from '@/lib/contracts';

const studio: VideoStudioResponse = {
  video: {
    video_id: 'video-1', playback_uri: 'https://media.example/video.mp4',
    duration_ms: 60_000, fps: 25, mime_type: 'video/mp4',
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
    expect(screen.getByText('Một cảnh trong studio.')).toBeInTheDocument();
    expect(screen.getAllByText('person').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Xin chào').length).toBeGreaterThan(0);
    const objectBox = screen.getByTestId('studio-object-box-object-1');
    expect(objectBox).toBeInTheDocument();
    expect(objectBox.querySelector('rect')).toHaveAttribute('stroke-width', '0.014');
    expect(objectBox.querySelector('text')).toHaveAttribute('font-size', '0.06');

    await user.click(screen.getByRole('button', { name: 'Dùng frame 50' }));
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
    expect(screen.getByRole('button', { name: 'Chọn frame 50' })).toBeInTheDocument();
  });
});
