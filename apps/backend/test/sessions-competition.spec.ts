import { DisabledCompetitionService } from '../src/competition/competition.service';
import { InMemorySessionRepository } from '../src/sessions/session.repository';
import { SessionsService } from '../src/sessions/sessions.service';
import { NotFoundException } from '@nestjs/common';

describe('session and competition boundaries', () => {
  it('returns immutable session revisions', async () => {
    const service = new SessionsService(new InMemorySessionRepository());
    const original = await service.create('find a red motorbike');
    const refined = await service.refine(original.sessionId, 'outdoor');
    expect(original.refinements).toEqual([]);
    expect(refined.refinements).toEqual(['outdoor']);
    await expect(service.get(original.sessionId)).resolves.toEqual(refined);
  });

  it('rejects unknown session identifiers', async () => {
    const service = new SessionsService(new InMemorySessionRepository());
    await expect(service.get('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows preview validation but rejects submission', () => {
    const service = new DisabledCompetitionService();
    expect(service.preview({ segmentId: 's', videoId: 'v', startMs: 0, endMs: 1000 }).enabled).toBe(false);
    expect(() => service.submit()).toThrow('disabled');
  });
});
