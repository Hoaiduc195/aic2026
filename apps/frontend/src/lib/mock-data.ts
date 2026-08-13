import type { SearchRequest, SearchResponse } from './contracts';

export function mockSearchResponse(request: SearchRequest): SearchResponse {
  const queryId = `mock-${request.task}-query`;
  const base = [
    {
      video_id: 'L21_V001',
      segment_id: 'L21_V001_seg_002',
      start_ms: 12_000,
      end_ms: 18_000,
      frame_id: 411,
      timestamp_ms: 13_700,
      score: 0.93,
      modalities: ['visual', 'ocr', 'asr'],
      snippet: 'Cửa hàng tạp hóa xuất hiện cùng lời thoại về giá cả.',
    },
    {
      video_id: 'L21_V002',
      segment_id: 'L21_V002_seg_014',
      start_ms: 43_500,
      end_ms: 49_200,
      frame_id: 1350,
      timestamp_ms: 45_000,
      score: 0.86,
      modalities: ['visual', 'asr'],
      snippet: 'Một người đi ngang qua quầy hàng trong khu phố.',
    },
    {
      video_id: 'L21_V003',
      segment_id: 'L21_V003_seg_006',
      start_ms: 88_000,
      end_ms: 94_600,
      frame_id: 2670,
      timestamp_ms: 89_000,
      score: 0.78,
      modalities: ['visual', 'ocr'],
      snippet: 'Biển hiệu và phương tiện giao thông nằm ở trung tâm khung hình.',
    },
  ];

  return {
    request_id: `request-${queryId}`,
    query_id: queryId,
    query: request.query,
    task: request.task,
    task_executor: `${request.task}_mock_v1`,
    dataset_version: 'qualification-v1',
    pipeline_version: 'mock-pipeline-v1',
    schema_version: '1.0.0',
    index_version: 'mock-index-v1',
    degraded: false,
    unavailable_branches: [],
    confidence: { level: 'high', score: 0.91, action: 'return' },
    results: base.slice(0, Math.min(Math.max(request.top_k, 1), base.length)).map((item) => ({
      segment_id: item.segment_id,
      video_id: item.video_id,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      preview_uri: `s3://aic-multimedia-artifacts/keyframes/${item.video_id}/${item.frame_id}.jpg`,
      score: item.score,
      representative_frame: {
        original_frame_id: item.frame_id,
        timestamp_ms: item.timestamp_ms,
        preview_uri: null,
      },
      evidence_ids: [`ev_${item.video_id}_01`, `ev_${item.video_id}_02`],
      evidence: [
        {
          evidence_id: `ev_${item.video_id}_01`,
          type: item.modalities.includes('ocr') ? 'ocr' : 'frame',
          start_ms: item.start_ms + 800,
          end_ms: item.start_ms + 2_800,
          snippet: item.snippet,
          producer: `${item.modalities[0]}:mock-v1`,
        },
        {
          evidence_id: `ev_${item.video_id}_02`,
          type: item.modalities.includes('asr') ? 'asr' : 'frame',
          start_ms: item.start_ms + 1_500,
          end_ms: item.start_ms + 3_900,
          snippet: item.snippet,
          producer: `${item.modalities.at(-1)}:mock-v1`,
        },
      ],
      matched_modalities: item.modalities,
    })),
  };
}
