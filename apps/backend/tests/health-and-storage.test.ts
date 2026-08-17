import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/common/config';
import { HealthController } from '../src/health/health.controller';
import { UnavailableObjectStorage } from '../src/storage/object-storage';
import { TaskExecutorRegistry } from '../src/tasks/task-registry';

describe('health and unavailable storage', () => {
  it('reports configured dependency health without exposing secrets', async () => {
    const config = { ...loadConfig(), databaseUrl: 'configured' };
    const database = { isConfigured: true, health: vi.fn(async () => false), query: vi.fn() };
    const storage = { isConfigured: true, health: vi.fn(async () => true), signReadUrl: vi.fn() };
    const registry = new TaskExecutorRegistry();
    registry.register({ task: 'textual_kis', name: 'test', execute: vi.fn() });
    const health = await new HealthController(config, [{ name: 'caption', search: vi.fn() }], registry, database, storage).health();
    expect(health).toMatchObject({ status: 'degraded', dependencies: { database: 'unhealthy', object_storage: 'healthy' } });
    expect(JSON.stringify(health)).not.toContain('configured"');
  });

  it('fails closed when R2 is unavailable', async () => {
    const storage = new UnavailableObjectStorage();
    expect(storage.isConfigured).toBe(false);
    await expect(storage.health()).resolves.toBe(false);
    await expect(storage.signReadUrl('videos/v.mp4')).rejects.toThrow('not configured');
  });

  it('reports an R2 outage as degraded even when the database is healthy', async () => {
    const config = loadConfig();
    const database = { isConfigured: true, health: vi.fn(async () => true), query: vi.fn() };
    const storage = { isConfigured: true, health: vi.fn(async () => false), signReadUrl: vi.fn() };
    const health = await new HealthController(config, [], new TaskExecutorRegistry(), database, storage).health();
    expect(health).toMatchObject({ status: 'degraded', dependencies: { database: 'healthy', object_storage: 'unhealthy' } });
  });
});
