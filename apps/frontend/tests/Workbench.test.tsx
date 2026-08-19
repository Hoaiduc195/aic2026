import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Workbench } from '@/components/Workbench';
import type {
  CanonicalFrameResponse,
  QueryImprovementResponse,
  SearchResponse,
  SelectionRevision,
  SubmissionPreview,
  VqaAnswerSuggestion,
  VideoPlayback,
  VideoStudioResponse,
} from '@/lib/contracts';

afterEach(() => {
  localStorage.clear();
});

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
      video_id: 'video_01',
      original_frame_id: 385,
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
      matched_modalities: ['embedding', 'ocr', 'asr'],
    },
  ],
};

const vqaResponse: SearchResponse = {
  ...response,
  query: 'Một cửa hàng trên phố\nCâu hỏi: Người phụ nữ đang cầm gì?',
  task: 'vqa',
  task_executor: 'vqa-retrieval-manual-ready-v1',
};

const vqaSuggestion: VqaAnswerSuggestion = {
  result_id: 'result-1',
  query_id: 'query_0001',
  video_id: 'video_01',
  original_frame_id: 385,
  timestamp_ms: 12_800,
  answer_status: 'answered',
  answer: 'Rẽ phải',
  normalized_answer: 'rẽ phải',
  evidence_ids: ['ev_ocr', 'ev_asr'],
  confidence: { level: 'high', score: 0.9 },
  producer: 'llm-vqa-openai-compatible',
  model_version: 'aic-qa-v1',
};

const playback: VideoPlayback = {
  video_id: 'video_01',
  playback_uri: '/api/v1/media/videos/video_01',
  duration_ms: 60_000,
  fps: 30,
  mime_type: 'video/mp4',
};

const studio: VideoStudioResponse = {
  video: playback,
  frames: [
    {
      video_id: 'video_01',
      keyframe_no: 5,
      original_frame_id: 385,
      timestamp_ms: 12_800,
      captions: [{ evidence_id: 'cap_385', text: 'Một cửa hàng', language: 'en', producer: 'caption:v1' }],
      objects: [{ evidence_id: 'obj_385', label: 'person', confidence: 0.9, normalized_bbox: [0.1, 0.2, 0.4, 0.8], producer: 'object:v1' }],
    },
    {
      video_id: 'video_01',
      keyframe_no: 6,
      original_frame_id: 411,
      timestamp_ms: 13_700,
      captions: [],
      objects: [],
    },
  ],
  asr_spans: [{
    evidence_id: 'asr_1', start_ms: 12_000, end_ms: 14_000, text: 'rẽ phải rồi đi thẳng', language: 'vi', producer: 'asr:v1',
  }],
};

function renderWorkbench({
  searchResponse = response,
  search = vi.fn(async () => searchResponse),
  loadStudio = vi.fn(async () => studio),
  loadFrame = vi.fn(async (): Promise<CanonicalFrameResponse> => ({
    video_id: 'video_01',
    keyframe_no: null,
    original_frame_id: 386,
    timestamp_ms: 12_833,
    captions: [],
    objects: [],
    thumbnail_uri: '/api/v1/media/videos/video_01/frames/386/thumbnail',
    is_exact_frame: true,
    annotation_source_frame_id: 385,
  })),
  saveSelection = vi.fn(async (): Promise<SelectionRevision> => ({
    selection_id: 'selection_01', query_id: 'query_0001', revision: 1, task: 'textual_kis',
    answers: [], note: null,
  })),
  createPreview = vi.fn(async (): Promise<SubmissionPreview> => ({
    query_id: 'query_0001', task: 'textual_kis', answer_count: 1, answers: [], csv: '', submittable: false, warnings: [],
  })),
  suggestVqaAnswer = vi.fn(async (): Promise<VqaAnswerSuggestion> => vqaSuggestion),
  improveQuery = vi.fn(async (): Promise<QueryImprovementResponse> => ({
    original_query: 'Một cửa hàng trên phố',
    improved_query: 'A shop on a street.',
    changed: true,
    producer: 'test-query-improver',
    model_version: 'test-model',
    warning: null,
  })),
} = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Workbench
        search={search}
        loadFrame={loadFrame}
        loadStudio={loadStudio}
        saveSelection={saveSelection}
        createPreview={createPreview}
        suggestVqaAnswer={suggestVqaAnswer}
        improveQuery={improveQuery}
      />
    </QueryClientProvider>,
  );
  return { ...view, search, loadStudio, saveSelection, createPreview };
}

describe('qualification frame-first workbench', () => {
  it('keeps a separate workspace when switching between tasks', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('');

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một người đang đi bộ');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người đó đang làm gì?');
    await user.click(screen.getByRole('tab', { name: 'Textual KIS' }));
    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('Một cửa hàng trên phố');

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('Một người đang đi bộ');
    expect(screen.getByLabelText('Câu hỏi')).toHaveValue('Người đó đang làm gì?');
  });

  it('shows successful queries in history and restores the selected workspace', async () => {
    const user = userEvent.setup();
    const { search } = renderWorkbench();

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await waitFor(() => expect(search).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Lịch Sử' }));
    const historyDialog = screen.getByRole('dialog', { name: 'Lịch sử query' });
    expect(historyDialog).toBeInTheDocument();
    expect(within(historyDialog).getByText('Một cửa hàng trên phố')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Khôi phục.*Một cửa hàng trên phố/ }));
    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('Một cửa hàng trên phố');
    expect(screen.getByText('video_01')).toBeInTheDocument();
  });

  it('writes one improved English query into the primary input before retrieval', async () => {
    const user = userEvent.setup();
    const improveQuery = vi.fn(async (): Promise<QueryImprovementResponse> => ({
      original_query: 'Một cửa hàng trên phố',
      improved_query: 'A shop on a street.',
      changed: true,
      producer: 'test-query-improver',
      model_version: 'test-model',
      warning: null,
    }));
    const { search } = renderWorkbench({ improveQuery });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByLabelText('Bật Query Improver'));
    await user.click(screen.getByRole('button', { name: 'Cải thiện query' }));

    expect(improveQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Một cửa hàng trên phố',
      task: 'textual_kis',
    }));
    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('A shop on a street.');
    expect(screen.queryByLabelText('Query tiếng Anh đã cải thiện')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'A shop on a street.' }));
  });

  it('does not show the original query as an improved preview when the improver falls back', async () => {
    const user = userEvent.setup();
    const improveQuery = vi.fn(async (): Promise<QueryImprovementResponse> => ({
      original_query: 'Một cửa hàng trên phố',
      improved_query: 'Một cửa hàng trên phố',
      changed: false,
      producer: 'query-improver-fallback',
      model_version: 'unconfigured',
      warning: 'query_improver_unavailable',
    }));
    renderWorkbench({ improveQuery });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByLabelText('Bật Query Improver'));
    await user.click(screen.getByRole('button', { name: 'Cải thiện query' }));

    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('Một cửa hàng trên phố');
    expect(screen.queryByLabelText('Query tiếng Anh đã cải thiện')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('chưa được cấu hình LLM');
  });

  it('runs an image-only search after confirming a frame from the result list', async () => {
    const user = userEvent.setup();
    const search = vi.fn(async (request) => request.frame_query
      ? { ...response, query: '', query_mode: 'frame_image' as const }
      : response);
    renderWorkbench({ search });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: /Tìm kiếm bằng/ }));
    expect(screen.getByRole('dialog', { name: 'Xác nhận tìm kiếm trên frame này' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Xác nhận tìm kiếm' }));

    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      query: '',
      task: 'textual_kis',
      frame_query: { video_id: 'video_01', original_frame_id: 385 },
    })));
  });

  it('improves both the event query and question for Q&A', async () => {
    const user = userEvent.setup();
    const improveQuery = vi.fn(async (): Promise<QueryImprovementResponse> => ({
      original_query: 'Một cửa hàng trên phố',
      improved_query: 'A shop on a street.',
      original_question: 'Người phụ nữ đang cầm gì?',
      improved_question: 'What is the woman holding?',
      changed: true,
      producer: 'test-query-improver',
      model_version: 'test-model',
      warning: null,
    }));
    const { search } = renderWorkbench({ improveQuery });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByLabelText('Bật Query Improver'));
    await user.click(screen.getByRole('button', { name: 'Cải thiện query & câu hỏi' }));

    expect(improveQuery).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Một cửa hàng trên phố',
      question: 'Người phụ nữ đang cầm gì?',
      task: 'vqa',
    }));
    expect(screen.getByLabelText('Mô tả sự kiện')).toHaveValue('A shop on a street.');
    expect(screen.getByLabelText('Câu hỏi')).toHaveValue('What is the woman holding?');

    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'A shop on a street.\nCâu hỏi: What is the woman holding?',
    }));
  });

  it('keeps task input in the left sidebar and exposes task-specific fields', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    expect(screen.getByLabelText('Bộ điều khiển tìm kiếm')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Kết quả frame' })).toBeInTheDocument();
    expect(screen.queryByText('Trung tâm sơ tuyển')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    expect(screen.getByLabelText('Câu hỏi')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'TRAKE' }));
    expect(screen.getByLabelText('Truy vấn chính')).toBeInTheDocument();
    expect(screen.getByLabelText('Mô tả sự kiện 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Thêm sự kiện' }));
    expect(screen.getByLabelText('Mô tả sự kiện 2')).toBeInTheDocument();
  });

  it('submits the TRAKE overview query before its ordered sub-events', async () => {
    const user = userEvent.setup();
    const { search } = renderWorkbench();

    await user.click(screen.getByRole('tab', { name: 'TRAKE' }));
    await user.type(screen.getByLabelText('Truy vấn chính'), 'Một người đi qua cửa hàng rồi rời đi');
    await user.type(screen.getByLabelText('Mô tả sự kiện 1'), 'Người bước vào cửa hàng');
    await user.click(screen.getByRole('button', { name: 'Thêm sự kiện' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện 2'), 'Người rời khỏi cửa hàng');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({
      task: 'trake',
      query: 'Một người đi qua cửa hàng rồi rời đi\n1. Người bước vào cửa hàng\n2. Người rời khỏi cửa hàng',
    })));
  });

  it('opens frame evidence and lazily loads only the video studio', async () => {
    const user = userEvent.setup();
    const { loadStudio } = renderWorkbench();

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    expect(screen.queryByText(/embedding/)).not.toBeInTheDocument();
    expect(screen.getByText('Cửa hàng tạp hóa')).toBeInTheDocument();
    expect(screen.getByText('rẽ phải rồi đi thẳng')).toBeInTheDocument();
    expect(loadStudio).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Xem các frame cùng video' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Các frame cùng video' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Xem video studio' }));
    expect(await screen.findByLabelText('Video video_01')).toHaveAttribute('src', playback.playback_uri);
    expect(loadStudio).toHaveBeenCalledWith('video_01', expect.anything());
  });

  it('persists an exact Studio frame as the representative result frame', async () => {
    const user = userEvent.setup();
    const loadFrame = vi.fn(async (_videoId: string, frameId: number): Promise<CanonicalFrameResponse> => ({
      video_id: 'video_01',
      keyframe_no: null,
      original_frame_id: frameId,
      timestamp_ms: 12_833,
      captions: [],
      objects: [],
      thumbnail_uri: `/api/v1/media/videos/video_01/frames/${frameId}/thumbnail`,
      is_exact_frame: true,
      annotation_source_frame_id: 385,
    }));
    renderWorkbench({ loadFrame });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));
    await user.click(screen.getByRole('button', { name: 'Xem video studio' }));

    const video = await screen.findByLabelText('Video video_01');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 386 / 30, writable: true });
    fireEvent.timeUpdate(video);
    await user.click(screen.getByRole('button', { name: 'Chọn frame hiện tại' }));

    expect(screen.queryByRole('dialog', { name: 'Video studio video_01' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Frame 386' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Frame 386 của video_01' })).toHaveAttribute(
      'src',
      '/api/v1/media/videos/video_01/frames/386/thumbnail',
    );
    expect(screen.getByRole('button', { name: 'Chọn frame video_01 · 386' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Thêm vào đáp án' }));
    await user.click(screen.getByRole('button', { name: 'Đáp án (1)' }));
    expect(screen.getByText('video_01 · frame 386')).toBeInTheDocument();
    expect(loadFrame).toHaveBeenCalledWith('video_01', 386, undefined);
  });

  it('does not render visual embedding evidence in the frame inspector', async () => {
    const user = userEvent.setup();
    const visualEmbeddingResponse: SearchResponse = {
      ...response,
      results: [{
        ...response.results[0],
        evidence_ids: ['ev_visual'],
        evidence: [{
          evidence_id: 'ev_visual',
          type: 'frame',
          snippet: 'visual embedding vector',
          producer: 'visual-embedding:v2',
        }],
        matched_modalities: ['visual'],
      }],
    };
    renderWorkbench({ searchResponse: visualEmbeddingResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    expect(screen.queryByText('Bằng chứng hình ảnh')).not.toBeInTheDocument();
    expect(screen.queryByText('visual embedding vector')).not.toBeInTheDocument();
    expect(screen.queryByText('visual')).not.toBeInTheDocument();
  });

  it('renders object evidence and only ASR overlapping the active frame', async () => {
    const user = userEvent.setup();
    const evidenceResponse: SearchResponse = {
      ...response,
      results: [{
        ...response.results[0],
        evidence: [
          { evidence_id: 'object-1', type: 'object', snippet: 'person', producer: 'object:v1' },
          { evidence_id: 'asr-overlap', type: 'asr', start_ms: 12_000, end_ms: 13_000, snippet: 'đang đi', producer: 'asr:v1' },
          { evidence_id: 'asr-outside', type: 'asr', start_ms: 20_000, end_ms: 21_000, snippet: 'đã rẽ', producer: 'asr:v1' },
        ],
        matched_modalities: ['object', 'asr'],
      }],
    };
    renderWorkbench({ searchResponse: evidenceResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    expect(screen.getByText('Object detection')).toBeInTheDocument();
    expect(screen.getByText('person')).toBeInTheDocument();
    expect(screen.getByText('đang đi')).toBeInTheDocument();
    expect(screen.queryByText('đã rẽ')).not.toBeInTheDocument();
  });

  it('shows the keyframe ordinal and source frame in the object result list', async () => {
    const user = userEvent.setup();
    const objectResponse: SearchResponse = {
      ...response,
      results: [{
        ...response.results[0],
        representative_frame: {
          ...response.results[0].representative_frame!,
          keyframe_no: 5,
        },
        evidence_ids: ['object-1'],
        evidence: [{ evidence_id: 'object-1', type: 'object', snippet: 'person', producer: 'object:v1' }],
        matched_modalities: ['object'],
      }],
    };
    renderWorkbench({ searchResponse: objectResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một người');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    expect(await screen.findByRole('button', {
      name: 'Chọn keyframe video_01 · 5 · source frame 385',
    })).toBeInTheDocument();
    expect(screen.getByText('Keyframe 5 · Source frame 385 · 12.80s')).toBeInTheDocument();
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

  it('reorders result frames and exports the ranked textual top 100', async () => {
    const user = userEvent.setup();
    const rankedResponse: SearchResponse = {
      ...response,
      results: [
        response.results[0],
        {
          ...response.results[0],
          video_id: 'video_02',
          original_frame_id: 410,
          representative_frame: { original_frame_id: 410, timestamp_ms: 15_000, preview_uri: null },
        },
        {
          ...response.results[0],
          video_id: 'video_03',
          original_frame_id: 530,
          representative_frame: { original_frame_id: 530, timestamp_ms: 18_000, preview_uri: null },
        },
      ],
    };
    renderWorkbench({ searchResponse: rankedResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    const rankedCards = () => screen.getAllByRole('button', { name: /^Chọn frame/ });
    expect(rankedCards().map((card) => card.getAttribute('aria-label'))).toEqual([
      'Chọn frame video_01 · 385',
      'Chọn frame video_02 · 410',
      'Chọn frame video_03 · 530',
    ]);

    await user.click(screen.getByRole('button', { name: 'Đưa frame video_01 · 385 xuống' }));
    expect(rankedCards().map((card) => card.getAttribute('aria-label'))).toEqual([
      'Chọn frame video_02 · 410',
      'Chọn frame video_01 · 385',
      'Chọn frame video_03 · 530',
    ]);
    expect(document.activeElement).toHaveAttribute('aria-label', 'Chọn frame video_01 · 385');

    const createObjectURL = vi.fn((_blob: Blob) => 'blob:ranked-json');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    await user.click(screen.getByRole('button', { name: 'Xuất JSON top 100' }));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const blobText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(JSON.parse(blobText)).toEqual({
      query_id: 'query_0001',
      task: 'textual_kis',
      answers: [
        { video_id: 'video_02', frame_id: 410 },
        { video_id: 'video_01', frame_id: 385 },
        { video_id: 'video_03', frame_id: 530 },
      ],
    });
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ranked-json');
    click.mockRestore();
  });

  it('moves a result frame directly to the top or bottom with boundary actions', async () => {
    const user = userEvent.setup();
    const rankedResponse: SearchResponse = {
      ...response,
      results: [
        response.results[0],
        {
          ...response.results[0],
          video_id: 'video_02',
          original_frame_id: 410,
          representative_frame: { original_frame_id: 410, timestamp_ms: 15_000, preview_uri: null },
        },
        {
          ...response.results[0],
          video_id: 'video_03',
          original_frame_id: 530,
          representative_frame: { original_frame_id: 530, timestamp_ms: 18_000, preview_uri: null },
        },
      ],
    };
    renderWorkbench({ searchResponse: rankedResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    const rankedCards = () => screen.getAllByRole('button', { name: /^Chọn frame/ });
    await user.click(screen.getByRole('button', { name: 'Upvote frame video_03 · 530 — đưa lên đầu' }));
    expect(rankedCards().map((card) => card.getAttribute('aria-label'))).toEqual([
      'Chọn frame video_03 · 530',
      'Chọn frame video_01 · 385',
      'Chọn frame video_02 · 410',
    ]);

    await user.click(screen.getByRole('button', { name: 'Downvote frame video_01 · 385 — đưa xuống cuối' }));
    expect(rankedCards().map((card) => card.getAttribute('aria-label'))).toEqual([
      'Chọn frame video_03 · 530',
      'Chọn frame video_02 · 410',
      'Chọn frame video_01 · 385',
    ]);
    expect(screen.queryByText('Downvote frame video_01 · 385')).not.toBeInTheDocument();
  });

  it('supports pointer drag and drop for changing frame rank', async () => {
    const user = userEvent.setup();
    const rankedResponse: SearchResponse = {
      ...response,
      results: [
        response.results[0],
        {
          ...response.results[0],
          video_id: 'video_02',
          original_frame_id: 410,
          representative_frame: { original_frame_id: 410, timestamp_ms: 15_000, preview_uri: null },
        },
        {
          ...response.results[0],
          video_id: 'video_03',
          original_frame_id: 530,
          representative_frame: { original_frame_id: 530, timestamp_ms: 18_000, preview_uri: null },
        },
      ],
    };
    renderWorkbench({ searchResponse: rankedResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    const cards = () => screen.getAllByRole('button', { name: /^Chọn frame/ })
      .map((button) => button.closest('.frame-card'));
    fireEvent.pointerDown(cards()[2]!, { pointerId: 1, button: 0, clientX: 10, clientY: 300 });
    fireEvent.pointerMove(cards()[0]!, { pointerId: 1, clientX: 10, clientY: 0 });
    expect(document.querySelectorAll('.frame-list-item--dragging')).toHaveLength(1);
    expect(screen.getByText('Thả để xếp ở vị trí #1')).toBeInTheDocument();
    const dragPreview = screen.getByLabelText('Đang kéo frame video_03 · 530');
    expect(dragPreview).toHaveClass('frame-card', 'frame-list-item', 'frame-list-item--spacious');
    expect(dragPreview.querySelector('.frame-list-main')).toBeInTheDocument();
    expect(dragPreview.querySelector('.frame-card-controls')).toBeInTheDocument();
    fireEvent.pointerUp(cards()[0]!, { pointerId: 1, clientX: 10, clientY: 0 });

    expect(screen.getAllByRole('button', { name: /^Chọn frame/ }).map((card) => card.getAttribute('aria-label'))).toEqual([
      'Chọn frame video_03 · 530',
      'Chọn frame video_01 · 385',
      'Chọn frame video_02 · 410',
    ]);
  });

  it('renders ranked frames as a thumbnail list and shifts items while dragging', async () => {
    const user = userEvent.setup();
    const rankedResponse: SearchResponse = {
      ...response,
      results: [
        response.results[0],
        {
          ...response.results[0],
          video_id: 'video_02',
          original_frame_id: 410,
          representative_frame: { original_frame_id: 410, timestamp_ms: 15_000, preview_uri: null },
        },
        {
          ...response.results[0],
          video_id: 'video_03',
          original_frame_id: 530,
          representative_frame: { original_frame_id: 530, timestamp_ms: 18_000, preview_uri: null },
        },
      ],
    };
    renderWorkbench({ searchResponse: rankedResponse });

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    const list = screen.getByRole('list', { name: 'Danh sách kết quả frame' });
    expect(list).toHaveClass('frame-list');
    expect(list).toHaveClass('frame-list-animated');
    expect(list.querySelectorAll('.frame-thumbnail')).toHaveLength(3);

    const items = () => Array.from(list.querySelectorAll('.frame-list-item:not(.frame-list-item--dragging)'));
    expect(items()[0]).toHaveClass('frame-list-item--spacious');
    fireEvent.pointerDown(items()[2]!, { pointerId: 2, button: 0, clientX: 10, clientY: 300 });
    fireEvent.pointerMove(items()[0]!, { pointerId: 2, clientX: 10, clientY: 0 });

    expect(screen.getByText('Thả để xếp ở vị trí #1')).toBeInTheDocument();
    expect(list.querySelectorAll('.frame-list-item--dragging')).toHaveLength(1);
    expect(items()).toHaveLength(2);
    expect(items()[0]).toHaveTextContent('video_01');
    expect(items()[1]).toHaveTextContent('video_02');
    expect(items()[1].querySelector('.rank-label')).toHaveTextContent('#3');
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

  it('fills the VQA queue with ranked frames and applies one answer to every pending item', async () => {
    const user = userEvent.setup();
    const multiFrameVqaResponse: SearchResponse = {
      ...vqaResponse,
      results: [385, 411, 530].map((frameId, index) => ({
        ...vqaResponse.results[0],
        video_id: `video_0${index + 1}`,
        original_frame_id: frameId,
        representative_frame: {
          original_frame_id: frameId,
          timestamp_ms: 12_800 + index * 1_000,
          preview_uri: null,
        },
      })),
    };
    renderWorkbench({ searchResponse: multiFrameVqaResponse });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(screen.getByRole('button', { name: 'Fill hàng đợi (0/100)' }));

    expect(screen.getByRole('button', { name: 'Đáp án (3)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Đáp án (3)' }));
    expect(screen.getAllByText('Đang chờ answer')).toHaveLength(3);

    await user.type(screen.getByLabelText('Áp dụng cùng answer cho pending'), 'một chiếc chai');
    await user.click(screen.getByRole('button', { name: 'Áp dụng (3)' }));

    expect(screen.getByText(/3\/100 item · 3 đã trả lời/)).toBeInTheDocument();
    expect(screen.getAllByText('một chiếc chai')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Export JSON' })).toBeEnabled();
  });

  it('runs batch VQA for the configured top-k frames without adding answers to the queue', async () => {
    const user = userEvent.setup();
    const suggestVqaAnswer = vi.fn(async () => vqaSuggestion);
    renderWorkbench({ searchResponse: vqaResponse, suggestVqaAnswer });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.clear(screen.getByLabelText('Số frame batch VQA'));
    await user.type(screen.getByLabelText('Số frame batch VQA'), '1');
    await user.click(screen.getByRole('button', { name: 'LLM trả lời Top-K' }));

    expect(await screen.findByText('Đã xử lý 1 frame: 1 answered; chưa thêm vào hàng đợi.')).toBeInTheDocument();
    expect(suggestVqaAnswer).toHaveBeenCalledWith(expect.objectContaining({
      query_id: 'query_0001',
      question: 'Người phụ nữ đang cầm gì?',
      video_id: 'video_01',
      original_frame_id: 385,
    }));
    expect(screen.getByRole('button', { name: 'Đáp án (0)' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Đáp án (0)' }));
    expect(screen.getByText('Chưa có đáp án.')).toBeInTheDocument();
  });

  it('stops a running VQA batch before sending the next rate-limited request', async () => {
    const user = userEvent.setup();
    const suggestVqaAnswer = vi.fn(async () => vqaSuggestion);
    const multiFrameVqaResponse: SearchResponse = {
      ...vqaResponse,
      results: [385, 411].map((frameId, index) => ({
        ...vqaResponse.results[0],
        video_id: `video_0${index + 1}`,
        original_frame_id: frameId,
        representative_frame: { original_frame_id: frameId, timestamp_ms: 12_800 + index * 1_000, preview_uri: null },
      })),
    };
    renderWorkbench({ searchResponse: multiFrameVqaResponse, suggestVqaAnswer });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.clear(screen.getByLabelText('Số frame batch VQA'));
    await user.type(screen.getByLabelText('Số frame batch VQA'), '2');
    await user.click(screen.getByRole('button', { name: 'LLM trả lời Top-K' }));
    await user.click(await screen.findByRole('button', { name: 'Dừng batch' }));

    expect(await screen.findByText(/Đã dừng batch VQA sau/, {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(suggestVqaAnswer).toHaveBeenCalledTimes(1);
  });

  it('suggests a VQA answer for the selected frame without queueing it automatically', async () => {
    const user = userEvent.setup();
    const suggestVqaAnswer = vi.fn(async () => vqaSuggestion);
    renderWorkbench({ searchResponse: vqaResponse, suggestVqaAnswer });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.click(screen.getByRole('button', { name: 'Cài đặt' }));
    await user.click(screen.getByLabelText('Bật cấu hình LLM từ frontend'));
    await user.type(screen.getByLabelText('Endpoint LLM'), 'https://llm.test/v1');
    await user.type(screen.getByLabelText('API key LLM'), 'request-secret');
    await user.type(screen.getByLabelText('Model LLM'), 'custom-v1');
    await user.clear(screen.getByLabelText('Timeout (ms)'));
    await user.type(screen.getByLabelText('Timeout (ms)'), '2500');
    await user.clear(screen.getByLabelText('Max tokens'));
    await user.type(screen.getByLabelText('Max tokens'), '64');
    await user.clear(screen.getByLabelText('Temperature'));
    await user.type(screen.getByLabelText('Temperature'), '0.2');
    await user.click(screen.getByRole('button', { name: 'Lưu cài đặt LLM' }));
    await user.click(screen.getByRole('button', { name: 'Cài đặt' }));
    await user.click(screen.getByLabelText('Bật VLM cho VQA đa phương thức'));
    await user.type(screen.getByLabelText('Endpoint VLM'), 'https://vision.test/v1');
    await user.type(screen.getByLabelText('API key VLM'), 'vision-secret');
    await user.type(screen.getByLabelText('Model VLM'), 'vision-v1');
    await user.clear(screen.getByLabelText('Timeout VLM (ms)'));
    await user.type(screen.getByLabelText('Timeout VLM (ms)'), '3000');
    await user.clear(screen.getByLabelText('Max tokens VLM'));
    await user.type(screen.getByLabelText('Max tokens VLM'), '256');
    await user.click(screen.getByRole('button', { name: 'Lưu cài đặt VLM' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));
    await user.click(screen.getByRole('button', { name: 'Gợi ý answer bằng LLM' }));

    expect(suggestVqaAnswer).toHaveBeenCalledWith({
      query_id: 'query_0001', question: 'Người phụ nữ đang cầm gì?', video_id: 'video_01', original_frame_id: 385,
      llm: {
        base_url: 'https://llm.test/v1', api_key: 'request-secret', model: 'custom-v1',
        timeout_ms: 2500, max_tokens: 64, temperature: 0.2,
      },
      vlm: {
        base_url: 'https://vision.test/v1', api_key: 'vision-secret', model: 'vision-v1',
        timeout_ms: 3000, max_tokens: 256, temperature: 0,
      },
    });
    expect(screen.getByRole('textbox', { name: 'Câu trả lời' })).toHaveValue('Rẽ phải');
    expect(screen.queryByText('Đáp án (1)')).not.toBeInTheDocument();
  });

  it('keeps the VQA suggestion and add-answer actions in a spaced action group', async () => {
    const user = userEvent.setup();
    renderWorkbench({ searchResponse: vqaResponse });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    const suggestionButton = screen.getByRole('button', { name: 'Gợi ý answer bằng LLM' });
    const addAnswerButton = screen.getByRole('button', { name: 'Thêm vào đáp án' });
    expect(suggestionButton.parentElement).toHaveClass('answer-builder-actions');
    expect(addAnswerButton.parentElement).toBe(suggestionButton.parentElement);
  });

  it('shows a readable error when single-frame VQA fails', async () => {
    const user = userEvent.setup();
    const suggestVqaAnswer = vi.fn(async () => {
      throw new Error('VQA service unavailable');
    });
    renderWorkbench({ searchResponse: vqaResponse, suggestVqaAnswer });

    await user.click(screen.getByRole('tab', { name: 'Hỏi & Đáp' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.type(screen.getByLabelText('Câu hỏi'), 'Người phụ nữ đang cầm gì?');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));
    await user.click(screen.getByRole('button', { name: 'Gợi ý answer bằng LLM' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('VQA service unavailable');
  });

  it('sends the current tab embedding settings with the search request', async () => {
    const user = userEvent.setup();
    const search = vi.fn(async () => response);
    renderWorkbench({ search });

    await user.click(screen.getByRole('button', { name: 'Cài đặt' }));
    await user.click(screen.getByLabelText('Bật cấu hình embedding từ frontend'));
    await user.type(screen.getByLabelText('Embedding service URL'), 'http://127.0.0.1:8001/embed');
    await user.type(screen.getByLabelText('API token embedding'), 'tab-secret');
    await user.clear(screen.getByLabelText('Timeout embedding (ms)'));
    await user.type(screen.getByLabelText('Timeout embedding (ms)'), '2500');
    await user.click(screen.getByRole('button', { name: 'Lưu cài đặt embedding' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    expect(search).toHaveBeenCalledWith({
      query: 'Một cửa hàng trên phố',
      task: 'textual_kis',
      session_id: expect.any(String),
      top_k: 20,
      retrieval: {
        display_k: 20,
        branch_k: 100,
        fusion_k: 500,
        near_frame_window_ms: 1000,
        rrf_k: 60,
        channel_weights: {
          visual: 1,
          clip: 1,
          ocr_lexical: 1.25,
          ocr_semantic: 1.25,
          asr_lexical: 1.25,
          asr_semantic: 1.25,
          caption: 1,
          object: 1.2,
          temporal: 1,
          audio: 1,
        },
      },
      embedding: {
        base_url: 'http://127.0.0.1:8001/embed',
        api_key: 'tab-secret',
        timeout_ms: 2500,
      },
    });
  });

  it('sends the retrieval limits configured in the left sidebar', async () => {
    const user = userEvent.setup();
    const search = vi.fn(async () => response);
    renderWorkbench({ search });

    await user.clear(screen.getByLabelText('Số frame hiển thị'));
    await user.type(screen.getByLabelText('Số frame hiển thị'), '40');
    await user.clear(screen.getByLabelText('Candidate mỗi modality'));
    await user.type(screen.getByLabelText('Candidate mỗi modality'), '150');
    await user.clear(screen.getByLabelText('Fusion candidate pool'));
    await user.type(screen.getByLabelText('Fusion candidate pool'), '600');
    await user.click(screen.getByRole('button', { name: 'Lưu cài đặt truy hồi' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    expect(search).toHaveBeenCalledWith({
      query: 'Một cửa hàng trên phố',
      task: 'textual_kis',
      session_id: expect.any(String),
      top_k: 40,
      retrieval: {
        display_k: 40,
        branch_k: 150,
        fusion_k: 600,
        near_frame_window_ms: 1000,
        rrf_k: 60,
        channel_weights: {
          visual: 1,
          clip: 1,
          ocr_lexical: 1.25,
          ocr_semantic: 1.25,
          asr_lexical: 1.25,
          asr_semantic: 1.25,
          caption: 1,
          object: 1.2,
          temporal: 1,
          audio: 1,
        },
      },
    });
  });

  it('sends RRF settings configured in the left sidebar', async () => {
    const user = userEvent.setup();
    const search = vi.fn(async () => response);
    renderWorkbench({ search });

    await user.clear(screen.getByLabelText('RRF K'));
    await user.type(screen.getByLabelText('RRF K'), '30');
    await user.clear(screen.getByLabelText('Trọng số object'));
    await user.type(screen.getByLabelText('Trọng số object'), '0.5');
    await user.click(screen.getByRole('button', { name: 'Lưu cấu hình RRF' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      retrieval: expect.objectContaining({
        rrf_k: 30,
        channel_weights: expect.objectContaining({ object: 0.5 }),
      }),
    }));
  });

  it('keeps numeric settings editable after clearing them and opens settings as a modal', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    const settingsTrigger = screen.getByRole('button', { name: 'Cài đặt' });
    await user.click(settingsTrigger);

    const dialog = screen.getByRole('dialog', { name: 'Cài đặt LLM' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('settings-popover');
    expect(dialog.parentElement).toHaveClass('settings-modal-layer');
    expect(document.body.querySelector('.settings-modal-layer')).toContainElement(dialog);
    expect(document.querySelector('.settings-modal-backdrop')).toBeInTheDocument();

    const timeout = screen.getByLabelText('Timeout (ms)');
    await user.clear(timeout);
    expect(timeout).toHaveValue(null);
    await user.type(timeout, '2500');
    expect(timeout).toHaveValue(2500);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Cài đặt LLM' })).not.toBeInTheDocument();
    expect(settingsTrigger).toHaveFocus();
  });

  it('groups VLM settings into a dedicated spaced section', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(screen.getByRole('button', { name: 'Cài đặt' }));

    const vlmSection = document.querySelector('[aria-labelledby="vlm-settings-title"]');
    expect(vlmSection).toHaveClass('settings-section');
    expect(vlmSection?.querySelector('.settings-section-heading')).toContainElement(
      screen.getByRole('heading', { name: 'Cài đặt VLM' }),
    );
  });

  it('builds an ordered TRAKE sequence from the selected frame and video studio', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.click(screen.getByRole('tab', { name: 'TRAKE' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện 1'), 'Người bước vào cửa hàng');
    await user.click(screen.getByRole('button', { name: 'Thêm sự kiện' }));
    await user.type(screen.getByLabelText('Mô tả sự kiện 2'), 'Người rời khỏi quầy');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    await user.click(screen.getAllByRole('button', { name: 'Gán frame hiện tại' })[0]);
    await user.click(screen.getByRole('button', { name: 'Xem video studio' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn keyframe 6 · source frame 411' }));
    await user.click(screen.getByRole('button', { name: 'Chọn frame đại diện (keyframe 6)' }));
    await user.click(screen.getByRole('button', { name: 'Gán frame hiện tại' }));
    await user.click(screen.getByRole('button', { name: 'Thêm chuỗi vào đáp án' }));

    await user.click(screen.getByRole('button', { name: 'Đáp án (1)' }));
    expect(screen.getByText('video_01 · frame 385 → 411')).toBeInTheDocument();
  });

  it('moves both selection and focus when navigating frame results with arrow keys', async () => {
    const user = userEvent.setup();
    const secondResult = {
      ...response.results[0],
      video_id: 'video_02',
      original_frame_id: 420,
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

  it('resizes the video panel with its accessible separator', async () => {
    const user = userEvent.setup();
    renderWorkbench();

    await user.type(screen.getByLabelText('Mô tả sự kiện'), 'Một cửa hàng trên phố');
    await user.click(screen.getByRole('button', { name: 'Tìm frame' }));
    await user.click(await screen.findByRole('button', { name: 'Chọn frame video_01 · 385' }));

    const separator = screen.getByRole('separator', { name: 'Điều chỉnh chiều rộng panel video' });
    expect(separator).toHaveAttribute('aria-valuenow', '410');

    separator.focus();
    await user.keyboard('{ArrowLeft}');
    expect(separator).toHaveAttribute('aria-valuenow', '430');
    await user.keyboard('{ArrowRight}');
    expect(separator).toHaveAttribute('aria-valuenow', '410');
  });
});
