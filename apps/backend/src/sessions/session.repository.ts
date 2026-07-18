import { Injectable } from '@nestjs/common';
import { immutable, immutableArray } from '../common/immutable';

export interface SearchSession {
  readonly sessionId: string; readonly originalQuery: string;
  readonly refinements: readonly string[]; readonly createdAt: string;
}
export abstract class SessionRepository {
  abstract save(session: SearchSession): Promise<SearchSession>;
  abstract findById(sessionId: string): Promise<SearchSession | undefined>;
}

@Injectable()
export class InMemorySessionRepository implements SessionRepository {
  private readonly sessions = new Map<string, SearchSession>();
  async save(session: SearchSession): Promise<SearchSession> {
    const copy = immutable({ ...session, refinements: immutableArray(session.refinements) });
    this.sessions.set(copy.sessionId, copy); return copy;
  }
  async findById(sessionId: string): Promise<SearchSession | undefined> { return this.sessions.get(sessionId); }
}
