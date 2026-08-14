import type { BackendConfig } from './config';

export interface RuntimeVersionManifest {
  readonly dataset_id: string;
  readonly dataset_version: string;
  readonly pipeline_version: string;
  readonly schema_version: string;
  readonly index_version: string;
  readonly artifact_versions: Readonly<Record<string, string>>;
  readonly model_versions: Readonly<Record<string, string>>;
  readonly checksums?: Readonly<Record<string, string>>;
  readonly created_at: string;
  readonly status: 'staged' | 'active' | 'retired';
}

export function createVersionManifest(config: BackendConfig, createdAt = new Date()): RuntimeVersionManifest {
  if (config.versionStatus === 'active' && (!config.indexChecksum || config.indexVersion === 'not-configured')) {
    throw new Error('active retrieval version requires a concrete index version and checksum');
  }
  return {
    dataset_id: config.datasetId,
    dataset_version: config.datasetVersion,
    pipeline_version: config.pipelineVersion,
    schema_version: config.schemaVersion,
    index_version: config.indexVersion,
    artifact_versions: { retrieval_input: config.artifactVersion },
    model_versions: config.modelVersions,
    ...(config.indexChecksum ? { checksums: { index: config.indexChecksum } } : {}),
    created_at: createdAt.toISOString(),
    status: config.versionStatus,
  };
}
