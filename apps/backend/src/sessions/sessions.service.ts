import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { immutable, immutableArray } from '../common/immutable';
import { SearchSession, SessionRepository } from './session.repository';

@Injectable()
export class SessionsService {
  constructor(private readonly repository: SessionRepository) {}
  create(originalQuery: string): Promise<SearchSession> {
    return this.repository.save(immutable({ sessionId: `ses_${randomUUID()}`, originalQuery, refinements: immutableArray([]), createdAt: new Date().toISOString() }));
  }
  async get(sessionId: string): Promise<SearchSession> {
    const session = await this.repository.findById(sessionId);
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }
  async refine(sessionId: string, refinement: string): Promise<SearchSession> {
    const current = await this.get(sessionId);
    return this.repository.save(immutable({ ...current, refinements: immutableArray([...current.refinements, refinement]) }));
  }
}
