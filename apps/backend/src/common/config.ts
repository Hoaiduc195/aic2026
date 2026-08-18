export interface BackendConfig {
  readonly datasetId: string;
  readonly port: number;
  readonly corsOrigins: string[];
  readonly operatorToken?: string;
  readonly allowUnauthenticatedLocal: boolean;
  readonly databaseUrl?: string;
  readonly databaseDirectUrl?: string;
  readonly r2EndpointUrl?: string;
  readonly r2Bucket?: string;
  readonly r2Region: string;
  readonly r2AccessKeyId?: string;
  readonly r2SecretAccessKey?: string;
  readonly signedUrlTtlSeconds: number;
  readonly embeddingServiceUrl?: string;
  readonly embeddingServiceToken?: string;
  readonly embeddingDimensions: number;
  readonly llmBaseUrl?: string;
  readonly llmApiKey?: string;
  readonly llmModel?: string;
  readonly llmTimeoutMs: number;
  readonly llmMaxTokens: number;
  readonly llmTemperature: number;
  readonly vlmEnabled: boolean;
  readonly vlmBaseUrl?: string;
  readonly vlmApiKey?: string;
  readonly vlmModel?: string;
  readonly vlmTimeoutMs: number;
  readonly vlmTopK: number;
  readonly vlmWeight: number;
  readonly vlmConcurrency: number;
  // Plan A: hard-filter candidates below this VLM score (0 = disabled)
  readonly vlmMinScore: number;
  // Plan B: expand query into additional English variants before search
  readonly vlmQueryExpansion: boolean;
  readonly vlmQueryExpansionMaxVariants: number;
  // Plan C: auto-adjust top_k based on score variance of candidates
  readonly vlmAdaptiveTopK: boolean;
  readonly datasetVersion: string;
  readonly pipelineVersion: string;
  readonly indexVersion: string;
  readonly schemaVersion: string;
  readonly artifactVersion: string;
  readonly modelVersions: Readonly<Record<string, string>>;
  readonly indexChecksum?: string;
  readonly versionStatus: 'staged' | 'active' | 'retired';
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function stringMap(value: string | undefined, fallback: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (!value) return fallback;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('MODEL_VERSIONS_JSON must be valid JSON'); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('MODEL_VERSIONS_JSON must be an object');
  const entries = Object.entries(parsed);
  if (entries.some(([key, item]) => !key || typeof item !== 'string' || !item.trim())) {
    throw new Error('MODEL_VERSIONS_JSON must map non-empty names to non-empty versions');
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, String(item).trim()]));
}

export function loadConfig(): BackendConfig {
  const runtimeEnvironment = optionalEnv('NODE_ENV') ?? 'development';
  const operatorToken = optionalEnv('OPERATOR_TOKEN');
  const allowUnauthenticatedLocal = runtimeEnvironment === 'development'
    && optionalEnv('ALLOW_UNAUTHENTICATED_LOCAL') === 'true';
  if (!operatorToken && runtimeEnvironment !== 'development' && runtimeEnvironment !== 'test') {
    throw new Error('OPERATOR_TOKEN is required outside local development');
  }
  const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const r2EndpointUrl = optionalEnv('R2_ENDPOINT_URL');
  const r2Bucket = optionalEnv('R2_BUCKET');
  const r2AccessKeyId = optionalEnv('R2_ACCESS_KEY_ID');
  const r2SecretAccessKey = optionalEnv('R2_SECRET_ACCESS_KEY');
  const r2Values = [r2EndpointUrl, r2Bucket, r2AccessKeyId, r2SecretAccessKey];
  if (r2Values.some(Boolean) && !r2Values.every(Boolean)) {
    throw new Error('R2_ENDPOINT_URL, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be configured together');
  }

  const llmBaseUrl = optionalEnv('LLM_BASE_URL');
  const llmModel = optionalEnv('LLM_MODEL');
  if (Boolean(llmBaseUrl) !== Boolean(llmModel)) {
    throw new Error('LLM_BASE_URL and LLM_MODEL must be configured together');
  }

  const versionStatus = optionalEnv('VERSION_STATUS') ?? 'staged';
  if (!['staged', 'active', 'retired'].includes(versionStatus)) throw new Error('VERSION_STATUS must be staged, active or retired');
  const indexChecksum = optionalEnv('INDEX_CHECKSUM');
  if (indexChecksum && !/^sha256:[0-9a-f]{64}$/.test(indexChecksum)) throw new Error('INDEX_CHECKSUM must be sha256:<64 lowercase hex>');
  const indexVersion = optionalEnv('INDEX_VERSION') ?? 'not-configured';
  if (versionStatus === 'active' && (!indexChecksum || indexVersion === 'not-configured')) {
    throw new Error('an active version requires INDEX_VERSION and INDEX_CHECKSUM');
  }

  return {
    datasetId: optionalEnv('DATASET_ID') ?? 'aic2026',
    port: positiveInteger(process.env.PORT, 4000),
    corsOrigins,
    operatorToken,
    allowUnauthenticatedLocal,
    databaseUrl: optionalEnv('DATABASE_URL'),
    databaseDirectUrl: optionalEnv('DATABASE_DIRECT_URL'),
    r2EndpointUrl,
    r2Bucket,
    r2Region: optionalEnv('R2_REGION') ?? 'auto',
    r2AccessKeyId,
    r2SecretAccessKey,
    signedUrlTtlSeconds: positiveInteger(process.env.R2_SIGNED_URL_TTL_SECONDS, 900),
    embeddingServiceUrl: optionalEnv('EMBEDDING_SERVICE_URL'),
    embeddingServiceToken: optionalEnv('EMBEDDING_SERVICE_TOKEN'),
    embeddingDimensions: positiveInteger(process.env.EMBEDDING_DIMENSIONS, 1024),
    llmBaseUrl,
    llmApiKey: optionalEnv('LLM_API_KEY'),
    llmModel,
    llmTimeoutMs: positiveInteger(process.env.LLM_TIMEOUT_MS, 15_000),
    llmMaxTokens: positiveInteger(process.env.LLM_MAX_TOKENS, 128),
    llmTemperature: boundedNumber(process.env.LLM_TEMPERATURE, 0, 0, 2),
    vlmEnabled: optionalEnv('VLM_ENABLED') === 'true',
    vlmBaseUrl: optionalEnv('VLM_BASE_URL') || llmBaseUrl,
    vlmApiKey: optionalEnv('VLM_API_KEY') || optionalEnv('LLM_API_KEY'),
    vlmModel: optionalEnv('VLM_MODEL') || llmModel || 'Qwen/Qwen2.5-VL-7B-Instruct',
    vlmTimeoutMs: positiveInteger(process.env.VLM_TIMEOUT_MS, 10_000),
    vlmTopK: positiveInteger(process.env.VLM_TOP_K, 20),
    vlmWeight: boundedNumber(process.env.VLM_WEIGHT, 0.7, 0, 1),
    vlmConcurrency: positiveInteger(process.env.VLM_CONCURRENCY, 4),
    // Plan A: filter frames with VLM score below threshold (0 = disabled)
    vlmMinScore: boundedNumber(process.env.VLM_MIN_SCORE, 0, 0, 100),
    // Plan B: generate additional English query variants before search
    vlmQueryExpansion: optionalEnv('VLM_QUERY_EXPANSION') === 'true',
    vlmQueryExpansionMaxVariants: positiveInteger(process.env.VLM_QUERY_EXPANSION_MAX_VARIANTS, 3),
    // Plan C: adaptively scale top_k based on RRF score spread
    vlmAdaptiveTopK: optionalEnv('VLM_ADAPTIVE_TOP_K') === 'true',
    datasetVersion: optionalEnv('DATASET_VERSION') ?? 'local',
    pipelineVersion: optionalEnv('PIPELINE_VERSION') ?? 'preprocessing-artifacts',
    indexVersion,
    schemaVersion: optionalEnv('SCHEMA_VERSION') ?? '1.0.0',
    artifactVersion: optionalEnv('ARTIFACT_VERSION') ?? 'preprocessing-artifacts',
    modelVersions: stringMap(optionalEnv('MODEL_VERSIONS_JSON'), {
      visual: 'vit-b-32-1024',
      object: 'yolo26n-coco',
      caption: 'florence-2-base',
    }),
    indexChecksum,
    versionStatus: versionStatus as BackendConfig['versionStatus'],
  };
}
