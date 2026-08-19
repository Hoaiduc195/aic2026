import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { loadConfig } from './common/config';
import {
  APP_CONFIG, DATABASE, EMBEDDING_SERVICE, EVIDENCE_REPOSITORY, LANGUAGE_MODEL, MEDIA_REPOSITORY,
  OBJECT_STORAGE, RETRIEVAL_BRANCHES, QUERY_EMBEDDER, RETRIEVAL_STORE, TASK_EXECUTOR_REGISTRY,
  VISION_LANGUAGE_MODEL, VLM_RERANKER, VLM_QUERY_EXPANDER, VQA_GROUNDING_REPOSITORY,
} from './common/tokens';
import {
  HttpQueryEmbeddingProvider,
  OpenAICompatibleLanguageModel,
  UnavailableLanguageModel,
  type QueryEmbeddingProvider,
  UnavailableQueryEmbeddingProvider,
} from './compute/model-ports';
import { OpenAICompatibleVisionClient, UnavailableVisionLanguageModel } from './compute/vlm-vision.client';
import type { DatabaseClient } from './database/database.client';
import { PostgresDatabase } from './database/postgres.database';
import { EmbeddingService } from './embedding_services/embedding.service';
import { HealthController } from './health/health.controller';
import { ManualController } from './manual/manual.controller';
import { SubmissionController } from './manual/submission.controller';
import { MediaController } from './media/media.controller';
import { PostgresMediaRepository, UnavailableMediaRepository } from './media/media.repository';
import { MediaService } from './media/media.service';
import { UnavailableRetrievalBranch, type RetrievalBranch } from './retrieval/branch';
import { PostgresObjectBranch, PostgresTextBranch } from './retrieval/postgres-branches';
import { PostgresClipBranch } from './retrieval/postgres-clip.branch';
import { RetrievalService } from './retrieval/retrieval.service';
import { VlmRerankerService } from './retrieval/vlm-reranker.service';
import { VlmQueryExpanderService } from './retrieval/vlm-query-expander.service';
import { QueryImproverController } from './query-improver/query-improver.controller';
import { QueryImproverService } from './query-improver/query-improver.service';
import { PostgresRetrievalStore, UnavailableRetrievalStore } from './retrieval/retrieval.store';
import { EmptyEvidenceRepository, PostgresEvidenceRepository } from './retrieval/evidence.repository';
import { SearchController } from './search/search.controller';
import { TextualKisExecutor } from './tasks/textual-kis/textual-kis.executor';
import { TaskExecutorRegistry } from './tasks/task-registry';
import { TrakeExecutor } from './tasks/trake/trake.executor';
import { VqaAnswerController } from './tasks/vqa/vqa-answer.controller';
import { VqaExecutor } from './tasks/vqa/vqa.executor';
import { VqaAnswerService } from './tasks/vqa/vqa-answer.service';
import { PostgresVqaGroundingRepository, UnavailableVqaGroundingRepository } from './tasks/vqa/vqa-grounding.repository';
import { R2ObjectStorage } from './storage/r2-object-storage';
import { UnavailableObjectStorage } from './storage/object-storage';

function createBranches(database: DatabaseClient, embedder: QueryEmbeddingProvider): RetrievalBranch[] {
  if (database.isConfigured) {
    return [
      new UnavailableRetrievalBranch('visual', 'visual query encoder is not configured'),
      new PostgresTextBranch('ocr_lexical', 'ocr', database),
      new UnavailableRetrievalBranch('ocr_semantic', 'OCR text embedding index is not configured'),
      new PostgresTextBranch('asr_lexical', 'asr', database),
      new UnavailableRetrievalBranch('asr_semantic', 'ASR text embedding index is not configured'),
      new PostgresTextBranch('caption', 'caption', database),
      new PostgresObjectBranch(database),
      new UnavailableRetrievalBranch('temporal', 'temporal aligner is not configured'),
      embedder.isConfigured
        ? new PostgresClipBranch(database, embedder)
        : new UnavailableRetrievalBranch('clip', 'CLIP query encoder is not configured'),
      new UnavailableRetrievalBranch('audio', 'audio query encoder is not configured'),
    ];
  }
  return [
    new UnavailableRetrievalBranch('visual'),
    new UnavailableRetrievalBranch('ocr_lexical'),
    new UnavailableRetrievalBranch('ocr_semantic'),
    new UnavailableRetrievalBranch('asr_lexical'),
    new UnavailableRetrievalBranch('asr_semantic'),
    new UnavailableRetrievalBranch('caption'),
    new UnavailableRetrievalBranch('object'),
    new UnavailableRetrievalBranch('temporal'),
    new UnavailableRetrievalBranch('clip'),
    new UnavailableRetrievalBranch('audio'),
  ];
}

function createTaskRegistry(config: ReturnType<typeof loadConfig>): TaskExecutorRegistry {
  const registry = new TaskExecutorRegistry();
  registry.register(new TextualKisExecutor());
  registry.register(new VqaExecutor(config));
  registry.register(new TrakeExecutor());
  return registry;
}

@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }])],
  controllers: [
    HealthController,
    SearchController,
    MediaController,
    ManualController,
    SubmissionController,
    VqaAnswerController,
    QueryImproverController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: loadConfig },
    {
      provide: DATABASE,
      useFactory: (config: ReturnType<typeof loadConfig>) => new PostgresDatabase(config.databaseUrl),
      inject: [APP_CONFIG],
    },
    {
      provide: QUERY_EMBEDDER,
      useFactory: (config: ReturnType<typeof loadConfig>) => config.embeddingServiceUrl
        ? new HttpQueryEmbeddingProvider(config.embeddingServiceUrl, config.embeddingDimensions, config.embeddingServiceToken)
        : new UnavailableQueryEmbeddingProvider(config.embeddingDimensions),
      inject: [APP_CONFIG],
    },
    {
      provide: EMBEDDING_SERVICE,
      useFactory: (database: DatabaseClient, defaultProvider: QueryEmbeddingProvider) => (
        new EmbeddingService(database, defaultProvider)
      ),
      inject: [DATABASE, QUERY_EMBEDDER],
    },
    {
      provide: LANGUAGE_MODEL,
      useFactory: (config: ReturnType<typeof loadConfig>) => config.llmBaseUrl && config.llmModel
        ? new OpenAICompatibleLanguageModel({
          baseUrl: config.llmBaseUrl,
          model: config.llmModel,
          apiKey: config.llmApiKey,
          timeoutMs: config.llmTimeoutMs,
          maxTokens: config.llmMaxTokens,
          temperature: config.llmTemperature,
        })
        : new UnavailableLanguageModel(),
      inject: [APP_CONFIG],
    },
    {
      provide: VISION_LANGUAGE_MODEL,
      useFactory: (config: ReturnType<typeof loadConfig>) => config.vlmEnabled && config.vlmBaseUrl && config.vlmModel
        ? new OpenAICompatibleVisionClient({
          baseUrl: config.vlmBaseUrl,
          model: config.vlmModel,
          apiKey: config.vlmApiKey,
          timeoutMs: config.vlmTimeoutMs,
          maxTokens: config.llmMaxTokens,
          temperature: config.llmTemperature,
        })
        : new UnavailableVisionLanguageModel(),
      inject: [APP_CONFIG],
    },
    { provide: RETRIEVAL_BRANCHES, useFactory: createBranches, inject: [DATABASE, QUERY_EMBEDDER] },
    {
      provide: OBJECT_STORAGE,
      useFactory: (config: ReturnType<typeof loadConfig>) => {
        if (!config.r2EndpointUrl || !config.r2Bucket || !config.r2AccessKeyId || !config.r2SecretAccessKey) {
          return new UnavailableObjectStorage();
        }
        return new R2ObjectStorage({
          endpoint: config.r2EndpointUrl, bucket: config.r2Bucket, region: config.r2Region,
          accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey,
          signedUrlTtlSeconds: config.signedUrlTtlSeconds,
        });
      },
      inject: [APP_CONFIG],
    },
    {
      provide: MEDIA_REPOSITORY,
      useFactory: (database: DatabaseClient) => database.isConfigured
        ? new PostgresMediaRepository(database)
        : new UnavailableMediaRepository(),
      inject: [DATABASE],
    },
    {
      provide: RETRIEVAL_STORE,
      useFactory: (database: DatabaseClient, config: ReturnType<typeof loadConfig>) => database.isConfigured
        ? new PostgresRetrievalStore(database, config.datasetVersion)
        : new UnavailableRetrievalStore(),
      inject: [DATABASE, APP_CONFIG],
    },
    {
      provide: EVIDENCE_REPOSITORY,
      useFactory: (database: DatabaseClient) => database.isConfigured
        ? new PostgresEvidenceRepository(database)
        : new EmptyEvidenceRepository(),
      inject: [DATABASE],
    },
    {
      provide: VQA_GROUNDING_REPOSITORY,
      useFactory: (database: DatabaseClient) => database.isConfigured
        ? new PostgresVqaGroundingRepository(database)
        : new UnavailableVqaGroundingRepository(),
      inject: [DATABASE],
    },
    {
      provide: VLM_RERANKER,
      useFactory: (config: ReturnType<typeof loadConfig>, vlm: OpenAICompatibleVisionClient | UnavailableVisionLanguageModel) => (
        new VlmRerankerService(config, vlm)
      ),
      inject: [APP_CONFIG, VISION_LANGUAGE_MODEL],
    },
    {
      provide: TASK_EXECUTOR_REGISTRY,
      useFactory: createTaskRegistry,
      inject: [APP_CONFIG],
    },
    {
      provide: VLM_QUERY_EXPANDER,
      useClass: VlmQueryExpanderService,
    },
    VlmRerankerService,
    VlmQueryExpanderService,
    RetrievalService,
    MediaService,
    VqaAnswerService,
    QueryImproverService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
