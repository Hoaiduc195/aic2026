import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const multiStudio: VideoStudioResponse = {
  ...studio,
  frames: [50, 100, 150, 200].map((originalFrameId, index) => ({
    ...studio.frames[0],
    keyframe_no: index + 1,
    original_frame_id: originalFrameId,
    timestamp_ms: (index + 1) * 2_000,
  })),
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

    await user.click(screen.getByRole('button', { name: 'Chọn frame đại diện (keyframe 1)' }));
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

  it('selects four distinct frames in TRAKE mode and returns them chronologically', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onSelectFrames = vi.fn();

    render(
      <VideoStudioModal
        studio={multiStudio}
        initialFrameId={50}
        selectionMode="multiple"
        onClose={onClose}
        onSelectFrames={onSelectFrames}
      />,
    );

    expect(screen.getByText('0/4 frame đã chọn')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Thêm frame đang xem vào bộ 4' }));
    await user.click(screen.getByRole('button', { name: 'Chọn keyframe 2 · source frame 100' }));
    await user.click(screen.getByRole('button', { name: 'Thêm frame đang xem vào bộ 4' }));
    await user.click(screen.getByRole('button', { name: 'Chọn keyframe 3 · source frame 150' }));
    await user.click(screen.getByRole('button', { name: 'Thêm frame đang xem vào bộ 4' }));
    await user.click(screen.getByRole('button', { name: 'Chọn keyframe 4 · source frame 200' }));
    await user.click(screen.getByRole('button', { name: 'Thêm frame đang xem vào bộ 4' }));

    expect(screen.getByText('4/4 frame đã chọn')).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'Xác nhận bộ 4 frame' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(onSelectFrames).toHaveBeenCalledWith(multiStudio.frames);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('rejects duplicate TRAKE frames and keeps confirmation disabled until four exist', async () => {
    const user = userEvent.setup();

    render(
      <VideoStudioModal
        studio={multiStudio}
        initialFrameId={50}
        selectionMode="multiple"
        onClose={vi.fn()}
        onSelectFrames={vi.fn()}
      />,
    );

    const addButton = screen.getByRole('button', { name: 'Thêm frame đang xem vào bộ 4' });
    await user.click(addButton);
    await user.click(addButton);

    expect(screen.getByRole('alert')).toHaveTextContent('Frame 50 đã có trong bộ 4');
    expect(screen.getByText('1/4 frame đã chọn')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xác nhận bộ 4 frame' })).toBeDisabled();
  });

  it('adds a downloaded arbitrary original frame to the TRAKE set', async () => {
    const user = userEvent.setup();
    const exactFrame: CanonicalFrameResponse = {
      video_id: 'video-1',
      keyframe_no: null,
      original_frame_id: 77,
      timestamp_ms: 3_080,
      thumbnail_uri: '/api/v1/media/videos/video-1/frames/77/thumbnail',
      is_exact_frame: true,
      annotation_source_frame_id: 50,
      captions: [],
      objects: [],
    };
    const loadExactFrame = vi.fn(async () => exactFrame);

    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        selectionMode="multiple"
        onClose={vi.fn()}
        onSelectFrames={vi.fn()}
        loadExactFrame={loadExactFrame}
      />,
    );

    const video = screen.getByLabelText('Video video-1');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 3.08, writable: true });
    fireEvent.timeUpdate(video);
    await user.click(screen.getByRole('button', { name: 'Tải frame hiện tại' }));

    await waitFor(() => {
      expect(loadExactFrame).toHaveBeenCalledWith(77);
      expect(screen.getByText('1/4 frame đã chọn')).toBeInTheDocument();
      expect(screen.getByText('Slot 1 · frame 77')).toBeInTheDocument();
    });
  });

  it('keeps a downloaded arbitrary frame visible after the video reports its seek time', async () => {
    const user = userEvent.setup();
    const exactFrame: CanonicalFrameResponse = {
      video_id: 'video-1',
      keyframe_no: null,
      original_frame_id: 77,
      timestamp_ms: 3_080,
      thumbnail_uri: '/api/v1/media/videos/video-1/frames/77/thumbnail',
      is_exact_frame: true,
      annotation_source_frame_id: 50,
      captions: [],
      objects: [],
    };
    const loadExactFrame = vi.fn(async () => exactFrame);

    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        selectionMode="multiple"
        onClose={vi.fn()}
        onSelectFrames={vi.fn()}
        loadExactFrame={loadExactFrame}
      />,
    );

    const video = screen.getByLabelText('Video video-1');
    let currentTime = 3.08;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => { currentTime = value; },
    });
    fireEvent.timeUpdate(video);
    await user.click(screen.getByRole('button', { name: 'Tải frame hiện tại' }));

    const selectedImage = await screen.findByTestId('studio-selected-frame-image');
    await waitFor(() => expect(selectedImage).toHaveAttribute(
      'src',
      '/api/v1/media/videos/video-1/frames/77/thumbnail',
    ));

    currentTime = 3.14;
    fireEvent.timeUpdate(video);

    expect(selectedImage).toHaveAttribute(
      'src',
      '/api/v1/media/videos/video-1/frames/77/thumbnail',
    );
  });

  it('loads the source frame that owns the live playhead time', async () => {
    const user = userEvent.setup();
    const loadExactFrame = vi.fn(async (frameId: number): Promise<CanonicalFrameResponse> => ({
      video_id: 'video-1',
      keyframe_no: null,
      original_frame_id: frameId,
      timestamp_ms: frameId * 40,
      thumbnail_uri: `/api/v1/media/videos/video-1/frames/${frameId}/thumbnail`,
      is_exact_frame: true,
      annotation_source_frame_id: 50,
      captions: [],
      objects: [],
    }));

    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        selectionMode="multiple"
        onClose={vi.fn()}
        onSelectFrames={vi.fn()}
        loadExactFrame={loadExactFrame}
      />,
    );

    const video = screen.getByLabelText('Video video-1');
    let currentTime = 3;
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => { currentTime = value; },
    });
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 });
    fireEvent.timeUpdate(video);

    // The browser has advanced to the frame beginning at 3.04s, before its next timeupdate event.
    currentTime = 3.06;
    await user.click(screen.getByRole('button', { name: 'Tải frame hiện tại' }));

    await waitFor(() => expect(loadExactFrame).toHaveBeenCalledWith(76));
    expect(screen.getByTestId('studio-selected-frame-image')).toHaveAttribute(
      'src',
      '/api/v1/media/videos/video-1/frames/76/thumbnail',
    );
  });

  it('uses the frame at the current video position without a manual frame ID', async () => {
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
    const onClose = vi.fn();
    const onSelectFrame = vi.fn();

    render(
      <VideoStudioModal
        studio={studio}
        initialFrameId={50}
        onClose={onClose}
        onSelectFrame={onSelectFrame}
        loadExactFrame={loadExactFrame}
      />,
    );

    const video = screen.getByLabelText('Video video-1');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 3.08, writable: true });
    fireEvent.timeUpdate(video);
    expect(screen.queryByLabelText('Frame ID trong video')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tải exact frame' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chọn frame hiện tại' }));

    expect(loadExactFrame).toHaveBeenCalledWith(77);
    await waitFor(() => {
      expect(onSelectFrame).toHaveBeenCalledWith(exactFrame);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
