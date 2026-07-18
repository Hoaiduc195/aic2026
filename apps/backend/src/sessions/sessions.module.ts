import { Module } from '@nestjs/common';
import { InMemorySessionRepository, SessionRepository } from './session.repository';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  controllers: [SessionsController],
  providers: [SessionsService, { provide: SessionRepository, useClass: InMemorySessionRepository }],
  exports: [SessionsService],
})
export class SessionsModule {}
