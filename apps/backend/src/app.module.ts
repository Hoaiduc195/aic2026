import { Module } from '@nestjs/common';
import { CompetitionModule } from './competition/competition.module';
import { HealthModule } from './health/health.module';
import { SearchModule } from './search/search.module';
import { SessionsModule } from './sessions/sessions.module';
@Module({ imports: [HealthModule, SearchModule, SessionsModule, CompetitionModule] })
export class AppModule {}
