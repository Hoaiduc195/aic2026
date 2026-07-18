import { Body, Controller, Post } from '@nestjs/common';
import { SearchRequestDto } from './search.dto';
import { SearchService } from './search.service';
@Controller('v1/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}
  @Post() search(@Body() dto: SearchRequestDto) { return this.searchService.search(dto); }
}
