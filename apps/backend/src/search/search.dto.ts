import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';

class SearchFiltersDto {
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) video_ids?: string[];
  @IsOptional() @IsInt() @Min(0) start_ms?: number | null;
  @IsOptional() @IsInt() @Min(0) end_ms?: number | null;
}

export class SearchRequestDto {
  @IsString() @MinLength(1) @MaxLength(2000) query: string;
  @IsOptional() @IsIn(['auto', 'textual_kis', 'video_kis', 'avs', 'vqa', 'kisc']) task = 'auto';
  @IsOptional() @IsInt() @Min(1) @Max(200) top_k = 50;
  @IsOptional() @ValidateNested() @Type(() => SearchFiltersDto) filters?: SearchFiltersDto;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @IsIn(['visual', 'ocr_lexical', 'asr_lexical'], { each: true }) branch_hints?: string[];
  @IsOptional() @IsInt() @Min(100) @Max(10_000) latency_budget_ms = 1500;
}
