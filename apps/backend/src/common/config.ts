export interface BackendConfig {
  readonly datasetId: string;
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
    indexVersion,
    schemaVersion: optionalEnv('SCHEMA_VERSION') ?? '1.0.0',
    artifactVersion: optionalEnv('ARTIFACT_VERSION') ?? 'preprocessing-artifacts',
    modelVersions: stringMap(optionalEnv('MODEL_VERSIONS_JSON'), {
      visual: 'dimension-awaiting-database-decision',
      object: 'yolo26n-coco',
      caption: 'florence-2-base',
    }),
    indexChecksum,
    versionStatus: versionStatus as BackendConfig['versionStatus'],
  };
}
