import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { immutable } from '../common/immutable';

export interface InternalCandidate { readonly segmentId: string; readonly videoId: string; readonly startMs: number; readonly endMs: number; }

@Injectable()
export class DisabledCompetitionService {
  preview(candidate: InternalCandidate) {
    return immutable({ enabled: false, valid: candidate.endMs > candidate.startMs, candidate: immutable({ ...candidate }), warnings: ['Organizer adapter is not configured; submission is disabled.'] });
  }
  submit(): never { throw new ServiceUnavailableException('Competition submission is disabled'); }
}
