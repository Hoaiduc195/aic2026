import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateSessionDto, RefineSessionDto } from './sessions.dto';
import { SessionsService } from './sessions.service';

@Controller('v1/sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}
  @Post() create(@Body() dto: CreateSessionDto) { return this.sessions.create(dto.query); }
  @Get(':sessionId') get(@Param('sessionId') id: string) { return this.sessions.get(id); }
  @Post(':sessionId/refine') refine(@Param('sessionId') id: string, @Body() dto: RefineSessionDto) { return this.sessions.refine(id, dto.refinement); }
}
