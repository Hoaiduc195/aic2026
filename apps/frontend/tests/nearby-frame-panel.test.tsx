import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { FrameCandidate, VideoFrame } from '@/lib/contracts';
import { NearbyFramePanel } from '@/components/workbench/NearbyFramePanel';

const firstFrame: FrameCandidate = {
  result_key: 'video_01\u0000385',
  video_id: 'video_01',
  original_frame_id: 385,
  timestamp_ms: 12_800,
  thumbnail_uri: '/frames/385.jpg',
  start_ms: 12_000,
  end_ms: 13_000,
  score: 0.91,
  evidence: [],
  matched_modalities: [],
};

const secondFrame: FrameCandidate = {
  ...firstFrame,
  result_key: 'video_01\u0000411',
  original_frame_id: 411,
  timestamp_ms: 13_700,
  thumbnail_uri: '/frames/411.jpg',
};

const loadedFrame: VideoFrame = {
  video_id: 'video_01',
  keyframe_no: 5,
  original_frame_id: 385,
  timestamp_ms: 12_800,
  thumbnail_uri: '/frames/385.jpg',
};

describe('NearbyFramePanel', () => {
  it('lets the user choose a center frame, set the window count, load, and export', async () => {
    const user = userEvent.setup();
    const onCenterChange = vi.fn();
    const onFrameCountChange = vi.fn();
    const onFrameStepChange = vi.fn();
    const onLoad = vi.fn();
    const onExport = vi.fn();

    render(
      <NearbyFramePanel
        frames={[firstFrame, secondFrame]}
        centerFrame={firstFrame}
        nearbyFrames={[loadedFrame]}
        frameCount="4"
        frameStep="1"
        loading={false}
        error={null}
        onCenterChange={onCenterChange}
        onFrameCountChange={onFrameCountChange}
        onFrameStepChange={onFrameStepChange}
        onLoad={onLoad}
        onExport={onExport}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Frame lân cận' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'video_01 · frame #385' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Frame trung tâm cho cửa sổ lân cận'), 'video_01\u0000411');
    expect(onCenterChange).toHaveBeenCalledWith(secondFrame);

    fireEvent.change(screen.getByLabelText('Top-K frame bao quát'), { target: { value: '6' } });
    expect(onFrameCountChange).toHaveBeenCalledWith('6');

    fireEvent.change(screen.getByLabelText('Khoảng cách giữa các frame (frame nguồn)'), { target: { value: '90' } });
    expect(onFrameStepChange).toHaveBeenCalledWith('90');

    await user.click(screen.getByRole('button', { name: 'Tải frame lân cận' }));
    await user.click(screen.getByRole('button', { name: 'Xuất CSV frame lân cận' }));
    expect(onLoad).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
  });

  it('shows loading and errors without enabling stale export actions', () => {
    render(
      <NearbyFramePanel
        frames={[firstFrame]}
        centerFrame={firstFrame}
        nearbyFrames={[]}
        frameCount="4"
        frameStep="1"
        loading
        error="Không thể tải frame."
        onCenterChange={vi.fn()}
        onFrameCountChange={vi.fn()}
        onFrameStepChange={vi.fn()}
        onLoad={vi.fn()}
        onExport={vi.fn()}
      />,
    );

    expect(screen.getByText('Đang tải frame lân cận…')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Không thể tải frame.');
    expect(screen.getByRole('button', { name: 'Xuất CSV frame lân cận' })).toBeDisabled();
  });
});
