import { Module } from '@nestjs/common';
import { CompetitionController } from './competition.controller';
import { DisabledCompetitionService } from './competition.service';
@Module({ controllers: [CompetitionController], providers: [DisabledCompetitionService] })
export class CompetitionModule {}
