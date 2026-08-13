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

  test('searches frames, lazy loads video and same-video frames, then queues the answer in the drawer', async ({ page }) => {
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
    expect(requests.playback).toBe(1);

    await page.getByRole('button', { name: 'Xem các frame cùng video' }).click();
    await expect(page.getByRole('button', { name: 'Chọn frame 351' })).toBeVisible();
    expect(requests.frames).toBe(1);

    await page.getByRole('button', { name: 'Chọn frame 351' }).click();
    await expect(page.getByText('Frame 351')).toBeVisible();

    await page.getByRole('button', { name: 'Thêm vào đáp án' }).click();
    await expect(page.getByText('video_01 · frame 351')).toHaveCount(0);

    await page.getByRole('button', { name: 'Đáp án (1)' }).click();
    await expect(page.getByRole('dialog', { name: 'Hàng đợi đáp án' })).toBeVisible();
    await expect(page.getByText('video_01 · frame 351')).toBeVisible();
  });
});
