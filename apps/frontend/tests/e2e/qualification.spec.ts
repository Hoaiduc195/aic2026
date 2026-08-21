import { expect, test, type Page } from '@playwright/test';

const searchResponse = {
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
      matched_modalities: ['visual', 'ocr', 'asr'],
    },
  ],
};

const playbackResponse = {
  video_id: 'video_01',
  playback_uri: '/api/v1/media/videos/video_01',
  duration_ms: 60_000,
  fps: 30,
  mime_type: 'video/mp4',
};

const frameContextResponse = {
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

const studioResponse = {
  video: playbackResponse,
  frames: [385, 411, 450, 500].map((original_frame_id, index) => ({
    video_id: 'video_01',
    keyframe_no: index + 5,
    original_frame_id,
    timestamp_ms: 12_800 + index * 1_000,
    captions: [],
    objects: index === 2 ? [{
      evidence_id: 'object-450',
      label: 'xe máy',
      confidence: 0.88,
      normalized_bbox: [0.2, 0.2, 0.5, 0.6],
      producer: 'object:v1',
    }] : [],
  })),
  asr_spans: [],
};

async function mockFrameFirstApis(page: Page) {
  const requests = {
    playback: 0,
    frames: 0,
  };

  await page.route('**/api/v1/search', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(searchResponse),
    });
  });

  await page.route('**/api/v1/videos/video_01/playback?frame_id=385', async (route) => {
    requests.playback += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(playbackResponse),
    });
  });

  await page.route('**/api/v1/videos/video_01/frames?center_frame_id=385&limit=25', async (route) => {
    requests.frames += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(frameContextResponse),
    });
  });

  await page.route('**/api/v1/videos/video_01/studio', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(studioResponse),
    });
  });

  await page.route('**/api/v1/media/videos/video_01', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: '',
    });
  });

  await page.route('**/api/v1/media/keyframes/video_01/by-frame/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      body: '',
    });
  });

  await page.route('**/api/v1/queries/query_0001/selection', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        selection_id: 'selection_0001',
        query_id: 'query_0001',
        revision: 1,
        task: 'textual_kis',
        answers: [{ video_id: 'video_01', frame_id: 385 }],
        note: null,
      }),
    });
  });

  await page.route('**/api/v1/submissions/preview', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        query_id: 'query_0001',
        task: 'textual_kis',
        answer_count: 1,
        answers: [{ video_id: 'video_01', frame_id: 385 }],
        csv: 'video_01,385\r\n',
        submittable: false,
        warnings: ['preview_only'],
      }),
    });
  });

  return requests;
}

test.describe('qualification frame-first workbench', () => {
  test('keeps task input in the left sidebar and exposes task-specific fields', async ({ page }) => {
    await mockFrameFirstApis(page);
    await page.goto('/');

    await expect(page.getByLabel('Bộ điều khiển tìm kiếm')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Kết quả frame' })).toBeVisible();
    await expect(page.getByText('Trung tâm sơ tuyển')).toHaveCount(0);

    await page.getByRole('tab', { name: 'Hỏi & Đáp' }).click();
    await expect(page.getByLabel('Câu hỏi')).toBeVisible();

    await page.getByRole('tab', { name: 'TRAKE' }).click();
    await expect(page.getByLabel('Mô tả sự kiện 1')).toBeVisible();
    await page.getByRole('button', { name: 'Thêm sự kiện' }).click();
    await expect(page.getByLabel('Mô tả sự kiện 2')).toBeVisible();
  });

  test('searches frames, opens video studio, then queues the answer in the drawer', async ({ page }) => {
    const requests = await mockFrameFirstApis(page);
    await page.goto('/');

    await page.getByLabel('Mô tả sự kiện').fill('Một cửa hàng trên phố');
    await page.getByRole('button', { name: 'Tìm frame' }).click();
    await page.getByRole('button', { name: 'Chọn frame video_01 · 385' }).click();

    await expect(page.getByText('Cửa hàng tạp hóa')).toBeVisible();
    await expect(page.getByText('rẽ phải rồi đi thẳng')).toBeVisible();
    expect(requests.playback).toBe(0);
    expect(requests.frames).toBe(0);

    await page.getByRole('button', { name: 'Xem video' }).click();
    await expect(page.getByLabel('Video video_01')).toHaveAttribute('src', playbackResponse.playback_uri);
    expect(requests.playback).toBe(0);

    await expect(page.getByRole('button', { name: 'Xem các frame cùng video' })).toHaveCount(0);
    expect(requests.frames).toBe(0);

    await page.getByRole('button', { name: 'Đóng video studio' }).click();
    await page.getByRole('button', { name: 'Thêm vào đáp án' }).click();
    await expect(page.getByText('video_01 · frame 385')).toHaveCount(0);

    await page.getByRole('button', { name: 'Đáp án (1)' }).click();
    await expect(page.getByRole('dialog', { name: 'Hàng đợi đáp án' })).toBeVisible();
    await expect(page.getByText('video_01 · frame 385')).toBeVisible();

    await page.getByRole('button', { name: 'Lưu đáp án' }).click();
    await expect(page.getByText('Đã lưu revision 1')).toBeVisible();
    await page.getByRole('button', { name: 'Tạo preview' }).click();
    await expect(page.getByText('Preview đã tạo cho 1 đáp án')).toBeVisible();
  });

  test('preserves task workspaces and restores a successful query from history', async ({ page }) => {
    await mockFrameFirstApis(page);
    await page.goto('/');

    await page.getByLabel('Mô tả sự kiện').fill('Một cửa hàng trên phố');
    await page.getByRole('tab', { name: 'Hỏi & Đáp' }).click();
    await expect(page.getByLabel('Mô tả sự kiện')).toHaveValue('');

    await page.getByLabel('Mô tả sự kiện').fill('Một người đang đi bộ');
    await page.getByLabel('Câu hỏi').fill('Người đó đang làm gì?');
    await page.getByRole('tab', { name: 'Textual KIS' }).click();
    await expect(page.getByLabel('Mô tả sự kiện')).toHaveValue('Một cửa hàng trên phố');

    await page.getByRole('button', { name: 'Tìm frame' }).click();
    await page.getByRole('button', { name: 'Lịch Sử' }).click();
    const history = page.getByRole('dialog', { name: 'Lịch sử query' });
    await expect(history).toBeVisible();
    await expect(history.getByText('Một cửa hàng trên phố')).toBeVisible();

    await history.getByRole('button', { name: /Khôi phục.*Một cửa hàng trên phố/ }).click();
    await expect(page.getByLabel('Mô tả sự kiện')).toHaveValue('Một cửa hàng trên phố');
    await expect(page.getByRole('button', { name: 'Chọn frame video_01 · 385' })).toBeVisible();
  });

  test('selects exactly four TRAKE frames and exposes their object evidence', async ({ page }) => {
    await mockFrameFirstApis(page);
    await page.goto('/');

    await page.getByRole('tab', { name: 'TRAKE' }).click();
    await page.getByLabel('Truy vấn chính').fill('Một người đi qua cửa hàng');
    await page.getByLabel('Mô tả sự kiện 1').fill('Người đi vào cửa hàng');
    await page.getByRole('button', { name: 'Tìm frame' }).click();
    await page.getByRole('button', { name: 'Chọn frame video_01 · 385' }).click();
    await page.getByRole('button', { name: 'Xem video studio' }).click();

    for (const keyframe of [5, 6, 7, 8]) {
      await page.getByRole('button', { name: 'Chọn keyframe ' + keyframe + ' · source frame ' + [385, 411, 450, 500][keyframe - 5] }).click();
      await page.getByRole('button', { name: 'Thêm frame đang xem vào bộ 4' }).click();
    }

    await expect(page.getByText('4/4 frame đã chọn')).toBeVisible();
    await page.getByRole('button', { name: 'Xác nhận bộ 4 frame' }).click();
    await expect(page.getByText('xe máy')).toBeVisible();
    await page.getByRole('button', { name: 'Thêm chuỗi vào đáp án' }).click();
    await page.getByRole('button', { name: 'Đáp án (1)' }).click();
    await expect(page.getByText('video_01 · frame 385 → 411 → 450 → 500')).toBeVisible();
  });
});
