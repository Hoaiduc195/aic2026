import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Workbench } from '@/components/Workbench';
import type { SearchResponse, SelectionRevision, SubmissionPreview, VideoFramesResponse, VideoPlayback } from '@/lib/contracts';

const response: SearchResponse = {
  request_id: 'request_0001',
  query_id: 'query_0001',
  task: 'textual_kis',
  task_executor: 'textual_kis_v1',
  dataset_version: 'qualification-v1',
  pipeline_version: 'pipe-v2',
  schema_version: '1.0.0',
  index_version: 'idx-v1',
  degraded: false,
  unavailable_branches: [],
  confidence: { level: 'high', score: 0.91 },
  results: [
    {
      segment_id: 'video_01_seg_01',
      video_id: 'video_01',
      start_ms: 10_000,
      end_ms: 16_000,
      preview_uri: 's3://demo/frame.webp',
      score: 0.91,
      representative_frame: {
        original_frame_id: 385,
        timestamp_ms: 12_800,
        preview_uri: null,
      },
      evidence_ids: ['ev_ocr', 'ev_asr'],
      evidence: [
        { evidence_id: 'ev_ocr', type: 'ocr', snippet: 'Cửa hàng tạp hóa', producer: 'ocr:v1' },
        { evidence_id: 'ev_asr', type: 'asr', snippet: 'rẽ phải rồi đi thẳng', producer: 'asr:v1' },
      ],
      matched_modalities: ['visual', 'ocr', 'asr'],
    },
  ],
};

const playback: VideoPlayback = {
  video_id: 'video_01',
  playback_uri: '/api/v1/media/videos/video_01',
  duration_ms: 60_000,
  fps: 30,
  mime_type: 'video/mp4',
};

const frameContext: VideoFramesResponse = {
  video_id: 'video_01',
  center_frame_id: 385,
  frames: [
    {
      video_id: 'video_01',
      keyframe_no: 4,
      original_frame_id: 351,
      timestamp_ms: 11_733,
      thumbnail_uri: '/api/v1/media/keyframes/video_01/by-frame/351',
    },
    {
      video_id: 'video_01',
      keyframe_no: 5,
      original_frame_id: 411,
      timestamp_ms: 13_700,
      thumbnail_uri: '/api/v1/media/keyframes/video_01/by-frame/411',
    },
  ],
};

function renderWorkbench({
  searchResponse = response,
  loadPlayback = vi.fn(async () => playback),
  loadFrames = vi.fn(async () => frameContext),
  saveSelection = vi.fn(async (): Promise<SelectionRevision> => ({
    selection_id: 'selection_01', query_id: 'query_0001', revision: 1, task: 'textual_kis',
    answers: [], note: null,
  })),
  createPreview = vi.fn(async (): Promise<SubmissionPreview> => ({
    query_id: 'query_0001', task: 'textual_kis', answer_count: 1, answers: [], csv: '', submittable: false, warnings: [],
  })),
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Workbench
        search={async () => searchResponse}
        loadPlayback={loadPlayback}
        loadFrames={loadFrames}
        saveSelection={saveSelection}
        createPreview={createPreview}
      />
    </QueryClientProvider>,
  );
  return { ...view, loadPlayback, loadFrames, saveSelection, createPreview };
}

describe('qualification frame-first workbench', () => {
  it('keeps task input in the left sidebar and exposes task-specific fields', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    expect(screen.getByLabelText('Bộ điều khiển tìm kiếm')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kết quả frame' })).toBeInTheDocument();
    expect(screen.queryByText('Trung tâm sơ tuyển')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    expect(screen.getByLabelText('Câu hỏi')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'TRAKE' }));
    expect(screen.getByLabelText('Mô tả sự kiện 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Thêm sự kiện' }));
    expect(screen.getByLabelText('Mô tả sự kiện 2')).toBeInTheDocument();
  });

  it('opens frame evidence and lazily loads video and neighboring frames', async () => {
    const user = userEvent.setup();
    const { loadPlayback, loadFrames } = renderWorkbench();

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    expect(screen.getByText('Cửa hàng tạp hóa')).toBeInTheDocument();
    expect(screen.getByText('rẽ phải rồi đi thẳng')).toBeInTheDocument();
    expect(loadPlayback).not.toHaveBeenCalled();
    expect(loadFrames).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Xem video' }));
    expect(await screen.findByLabelText('Video video_01')).toHaveAttribute('src', playback.playback_uri);
    expect(loadPlayback).toHaveBeenCalledWith('video_01', 385);

    await user.click(screen.getByRole('button', { name: 'Xem các frame cùng video' }));
    expect(await screen.findByRole('button', { name: 'Chọn frame 351' })).toBeInTheDocument();
    expect(loadFrames).toHaveBeenCalledWith('video_01', 385, 25);

    await user.click(screen.getByRole('button', { name: 'Chọn frame 351' }));
    expect(screen.getByText('Frame 351')).toBeInTheDocument();
  });

  it('adds the selected frame and reveals answers only through the drawer badge', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderWorkbench();

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));
    await user.click(screen.getByRole('button', { name: 'Thêm vào đáp án' }));

    expect(screen.queryByText('video_01 · frame 385')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Đáp án (1)' }));
    expect(screen.getByRole('dialog', { name: 'Hàng đợi đáp án' })).toBeInTheDocument();
    expect(screen.getByText('video_01 · frame 385')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sao chép JSON' }));
    expect(writeText).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Xóa đáp án 1' }));
    expect(screen.getByText('Chưa có đáp án.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Hàng đợi đáp án' })).not.toBeInTheDocument();
  });

  it('saves the answer queue and creates a backend preview', async () => {
    const user = userEvent.setup();
    const saveSelection = vi.fn(async (): Promise<SelectionRevision> => ({
      selection_id: 'selection_03', query_id: 'query_0001', revision: 3, task: 'textual_kis',
      answers: [], note: null,
    }));
    const createPreview = vi.fn(async (): Promise<SubmissionPreview> => ({
      query_id: 'query_0001', task: 'textual_kis', answer_count: 1, answers: [], csv: '', submittable: false, warnings: ['preview_only'],
    }));
    renderWorkbench({ saveSelection, createPreview });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));
    await user.click(screen.getByRole('button', { name: 'Thêm vào đáp án' }));
    await user.click(screen.getByRole('button', { name: 'Đáp án (1)' }));

    await user.click(screen.getByRole('button', { name: 'Lưu đáp án' }));
    expect(saveSelection).toHaveBeenCalledWith(
      'query_0001',
      'textual_kis',
      [{ video_id: 'video_01', frame_id: 385 }],
    );
    expect(await screen.findByText('Đã lưu revision 3')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tạo preview' }));
    expect(createPreview).toHaveBeenCalledWith(
      'query_0001',
      'textual_kis',
      [{ video_id: 'video_01', frame_id: 385 }],
    );
    expect(await screen.findByText('Preview đã tạo cho 1 đáp án')).toBeInTheDocument();
  });

  it('requires a short answer for Q&A before queueing the selected evidence frame', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người nói hướng nào?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));
    await user.click(screen.getByRole('button', { name: 'Thêm vào đáp án' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Hãy nhập câu trả lời');

    await user.type(screen.getByLabelText('Câu trả lời'), 'Rẽ phải');
    await user.click(screen.getByRole('button', { name: 'Thêm vào đáp án' }));
    await user.click(screen.getByRole('button', { name: 'Đáp án (1)' }));
    expect(screen.getByText('Rẽ phải')).toBeInTheDocument();
  });

  it('builds an ordered TRAKE sequence from the selected frame and its filmstrip', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(screen.getByRole('tab', { name: 'TRAKE' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện 1'), 'Người bước vào cửa hàng');
    await user.click(screen.getByRole('button', { name: 'Thêm sự kiện' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện 2'), 'Người rời khỏi quầy');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    await user.click(screen.getAllByRole('button', { name: 'Gán frame hiện tại' })[0]);
    await user.click(screen.getByRole('button', { name: 'Xem các frame cùng video' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame 411' }));
    await user.click(screen.getByRole('button', { name: 'Gán frame hiện tại' }));
    await user.click(screen.getByRole('button', { name: 'Thêm chuỗi vào đáp án' }));

    await user.click(screen.getByRole('button', { name: 'Đáp án (1)' }));
    expect(screen.getByText('video_01 · frame 385 → 411')).toBeInTheDocument();
  });

  it('moves both selection and focus when navigating frame results with arrow keys', async () => {
    const user = userEvent.setup();
    const secondResult = {
      ...response.results[0],
      segment_id: 'video_02_seg_01',
      video_id: 'video_02',
      representative_frame: { original_frame_id: 420, timestamp_ms: 14_000, preview_uri: null },
    };
    renderWorkbench({ searchResponse: { ...response, results: [...response.results, secondResult] } });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    const first = await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' });
    const second = screen.getByRole('button', { name: 'Chọn frame video_02 · 420' });
    first.focus();
    await user.keyboard('{ArrowRight}');

    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(second).toHaveFocus();
  });
});
