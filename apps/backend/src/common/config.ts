export interface BackendConfig {
  readonly port: number;
  readonly corsOrigins: string[];
  readonly operatorToken?: string;
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
  readonly datasetVersion: string;
  readonly pipelineVersion: string;
  readonly indexVersion: string;
  readonly schemaVersion: string;
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

export function loadConfig(): BackendConfig {
  const operatorToken = optionalEnv('OPERATOR_TOKEN');
  if (process.env.NODE_ENV === 'production' && !operatorToken) {
    throw new Error('OPERATOR_TOKEN is required when NODE_ENV=production');
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

  return {
    port: positiveInteger(process.env.PORT, 4000),
    corsOrigins,
    operatorToken,
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
    datasetVersion: optionalEnv('DATASET_VERSION') ?? 'local',
    pipelineVersion: optionalEnv('PIPELINE_VERSION') ?? 'preprocessing-artifacts',
    indexVersion: optionalEnv('INDEX_VERSION') ?? 'not-configured',
    schemaVersion: optionalEnv('SCHEMA_VERSION') ?? '1.0.0',
  };
}
