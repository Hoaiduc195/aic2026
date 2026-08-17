import { Controller, Get, Inject } from '@nestjs/common';

import type { BackendConfig } from '../common/config';
import { APP_CONFIG, DATABASE, OBJECT_STORAGE, RETRIEVAL_BRANCHES, TASK_EXECUTOR_REGISTRY } from '../common/tokens';
import type { DatabaseClient } from '../database/database.client';
import type { ObjectStorage } from '../storage/object-storage';
import type { RetrievalBranch } from '../retrieval/branch';
import { TaskExecutorRegistry } from '../tasks/task-registry';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: BackendConfig,
    @Inject(RETRIEVAL_BRANCHES) private readonly branches: readonly RetrievalBranch[],
    @Inject(TASK_EXECUTOR_REGISTRY) private readonly executors: TaskExecutorRegistry,
    @Inject(DATABASE) private readonly database: DatabaseClient,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Get()
  async health() {
    const [databaseHealthy, storageHealthy] = await Promise.all([
      this.database.health(),
      this.storage.health(),
    ]);
    const databaseDegraded = this.database.isConfigured && !databaseHealthy;
    const storageDegraded = this.storage.isConfigured && !storageHealthy;
    return {
      status: databaseDegraded || storageDegraded ? 'degraded' : 'ok',
      service: '@aic2026/backend',
      mode: 'offline-first',
      dependencies: {
        database: !this.database.isConfigured ? 'not_configured' : databaseHealthy ? 'healthy' : 'unhealthy',
        object_storage: !this.storage.isConfigured ? 'not_configured' : storageHealthy ? 'healthy' : 'unhealthy',
      },
      retrieval_branches: this.branches.map((branch) => branch.name),
      task_executors: this.executors.names(),
    };
  }
}
