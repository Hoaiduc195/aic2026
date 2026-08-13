import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RETRIEVAL_STORE } from '../src/common/tokens';
import { createOperatorAuthMiddleware } from '../src/common/operator-auth.middleware';
import { ManualController } from '../src/manual/manual.controller';
import { SubmissionController } from '../src/manual/submission.controller';
import { MediaController } from '../src/media/media.controller';
import { MediaService } from '../src/media/media.service';
import { RetrievalService } from '../src/retrieval/retrieval.service';
import { SearchController } from '../src/search/search.controller';

describe('backend HTTP API', () => {
  let app: INestApplication;
  const retrieval = {
    search: vi.fn(async (input) => ({ query_id: 'q-1', query: input.query, results: [] })),
    createPlan: vi.fn((input) => ({ query_id: 'q-plan', original_query: input.query })),
  };
  const media = {
    getPlayback: vi.fn(async (videoId) => ({ video_id: videoId, playback_uri: 'https://signed/video', duration_ms: 10, fps: 25, mime_type: 'video/mp4' })),
    getFrames: vi.fn(async (videoId, centerFrameId) => ({ video_id: videoId, center_frame_id: centerFrameId, frames: [] })),
  };
  const store = {
    listCandidates: vi.fn(async (queryId, limit, offset) => ({ query_id: queryId, total: 0, limit, offset, candidates: [] })),
    getLatestSelection: vi.fn(async () => null),
    saveSelection: vi.fn(async (_queryId, task, answers) => ({ revision: 1, task, answers })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [SearchController, MediaController, ManualController, SubmissionController],
      providers: [
        { provide: RetrievalService, useValue: retrieval },
        { provide: MediaService, useValue: media },
        { provide: RETRIEVAL_STORE, useValue: store },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(createOperatorAuthMiddleware('operator-secret'));
    await app.init();
  });

  afterAll(async () => app.close());

  it('protects operator routes and validates search input', async () => {
    await request(app.getHttpServer()).post('/v1/search').send({ query: 'bike', task: 'textual_kis' }).expect(401);
    await request(app.getHttpServer()).post('/v1/search').set('x-operator-token', 'operator-secret')
      .send({ query: 'bike', task: 'textual_kis', top_k: 10 }).expect(201)
      .expect(({ body }) => expect(body.query).toBe('bike'));
    await request(app.getHttpServer()).post('/v1/search').set('x-operator-token', 'operator-secret')
      .send({ query: '', task: 'textual_kis' }).expect(400);
  });

  it('serves playback/frame context and rejects unsafe identifiers', async () => {
    await request(app.getHttpServer()).get('/v1/videos/video-1/playback?frame_id=2')
      .set('x-operator-token', 'operator-secret').expect(200)
      .expect(({ body }) => expect(body.playback_uri).toContain('https://'));
    await request(app.getHttpServer()).get('/v1/videos/video-1/frames?center_frame_id=2&limit=25')
      .set('x-operator-token', 'operator-secret').expect(200);
    await request(app.getHttpServer()).get('/v1/videos/bad%20id/playback')
      .set('x-operator-token', 'operator-secret').expect(400);
  });

  it('supports configurable manual top-k, revision save and preview-only export', async () => {
    await request(app.getHttpServer()).get('/v1/queries/q-1/candidates?limit=250&offset=10')
      .set('x-operator-token', 'operator-secret').expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ limit: 250, offset: 10 }));

    const body = { task: 'vqa', answers: [{ video_id: 'video-1', frame_id: 2, answer: 'red' }] };
    await request(app.getHttpServer()).put('/v1/queries/q-1/selection')
      .set('x-operator-token', 'operator-secret').send(body).expect(200)
      .expect(({ body: responseBody }) => expect(responseBody.revision).toBe(1));
    await request(app.getHttpServer()).post('/v1/submissions/preview')
      .set('x-operator-token', 'operator-secret').send({ query_id: 'q-1', ...body }).expect(201)
      .expect(({ body: responseBody }) => expect(responseBody.submittable).toBe(false));
  });
});
