import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../src/app.module';

describe('backend API', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(() => app.close());

  it('reports health', () => request(app.getHttpServer()).get('/healthz').expect(200).expect({ status: 'ok' }));
  it('reports readiness', () => request(app.getHttpServer()).get('/readyz').expect(200).expect((response) => {
    expect(response.body).toMatchObject({ status: 'ready', dependencies: { retrieval: 'degraded' } });
  }));

  it('creates, retrieves, and refines a search session', async () => {
    const created = await request(app.getHttpServer()).post('/v1/sessions').send({ query: 'red motorbike' }).expect(201);
    const sessionId = created.body.sessionId;
    await request(app.getHttpServer()).post(`/v1/sessions/${sessionId}/refine`).send({ refinement: 'outdoor' }).expect(201);
    const fetched = await request(app.getHttpServer()).get(`/v1/sessions/${sessionId}`).expect(200);
    expect(fetched.body.refinements).toEqual(['outdoor']);
  });

  it('previews but never submits competition payloads', async () => {
    const payload = { segment_id: 's', video_id: 'v', start_ms: 0, end_ms: 1000 };
    await request(app.getHttpServer()).post('/v1/submissions/preview').send(payload).expect(201);
    await request(app.getHttpServer()).post('/v1/submissions').send(payload).expect(503);
  });

  it('strictly rejects unknown search fields', () => request(app.getHttpServer()).post('/v1/search')
    .send({ query: 'hello', unknown: true }).expect(400));

  it('honors explicit branch and hard temporal/video filters', async () => {
    const base = { query: 'Bến Thành', branch_hints: ['ocr_lexical'], top_k: 5 };
    const excludedVideo = await request(app.getHttpServer()).post('/v1/search')
      .send({ ...base, filters: { video_ids: ['different-video'] } }).expect(201);
    expect(excludedVideo.body.results).toEqual([]);
    const excludedTime = await request(app.getHttpServer()).post('/v1/search')
      .send({ ...base, filters: { start_ms: 5000, end_ms: 6000 } }).expect(201);
    expect(excludedTime.body.results).toEqual([]);
    const included = await request(app.getHttpServer()).post('/v1/search')
      .send({ ...base, filters: { video_ids: ['golden-video'], start_ms: 0, end_ms: 5000 } }).expect(201);
    expect(included.body.results[0].segment_id).toBe('seg-ben-thanh');
  });

  it('returns a versioned contract-valid response from the fixture index', async () => {
    const response = await request(app.getHttpServer()).post('/v1/search')
      .send({ query: 'xe máy màu đỏ', task: 'auto', top_k: 10, latency_budget_ms: 500 }).expect(201);
    expect(response.body).toMatchObject({ task: 'textual_kis', degraded: false });
    expect(response.body.results[0]).toMatchObject({ segment_id: 'seg-red-motorbike', matched_modalities: ['visual'] });
    expect(response.body.request_id).toMatch(/^req_/);
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const contracts = resolve(__dirname, '../../../contracts/schemas');
    const versionSchema = JSON.parse(readFileSync(resolve(contracts, 'version_manifest/schema.json'), 'utf8'));
    const branchSchema = JSON.parse(readFileSync(resolve(contracts, 'branch_result/schema.json'), 'utf8'));
    const responseSchema = JSON.parse(readFileSync(resolve(contracts, 'search_response/schema.json'), 'utf8'));
    ajv.addSchema(versionSchema).addSchema(branchSchema);
    const validate = ajv.compile(responseSchema);
    expect(validate(response.body)).toBe(true);
  });
});
