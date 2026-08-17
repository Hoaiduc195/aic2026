import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { VideoTimelineOverlay } from '@/components/workbench/VideoTimelineOverlay';
import type { StudioAsrSpan, StudioFrame } from '@/lib/contracts';

const frames: StudioFrame[] = [
  { video_id: 'video-1', keyframe_no: 1, original_frame_id: 0, timestamp_ms: 0, captions: [], objects: [] },
  { video_id: 'video-1', keyframe_no: 2, original_frame_id: 50, timestamp_ms: 2_000, captions: [], objects: [] },
];

const spans: StudioAsrSpan[] = [
  { evidence_id: 'asr-1', start_ms: 1_000, end_ms: 3_000, text: 'Xin chào', language: 'vi', producer: 'asr:v1' },
];

describe('VideoTimelineOverlay', () => {
  it('renders SVG ASR/frame overlays and seeks when a frame or span is clicked', async () => {
    const user = userEvent.setup();
    const onSeek = vi.fn();
    const onFrameSelect = vi.fn();

    render(
      <VideoTimelineOverlay
        durationMs={4_000}
        currentTimeMs={1_500}
        frames={frames}
        asrSpans={spans}
        selectedFrameId={0}
        onSeek={onSeek}
        onFrameSelect={onFrameSelect}
      />,
    );

    expect(screen.getByLabelText('Timeline video')).toBeInTheDocument();
    expect(screen.getByLabelText('ASR: Xin chào')).toBeInTheDocument();
    expect(screen.getByLabelText('Frame 50 tại 2.00s')).toBeInTheDocument();
    expect(document.querySelector('svg')).toBeInTheDocument();

    await user.click(screen.getByLabelText('ASR: Xin chào'));
    expect(onSeek).toHaveBeenCalledWith(1_000);

    await user.click(screen.getByLabelText('Frame 50 tại 2.00s'));
    expect(onSeek).toHaveBeenCalledWith(2_000);
    expect(onFrameSelect).toHaveBeenCalledWith(frames[1]);
  });
});
