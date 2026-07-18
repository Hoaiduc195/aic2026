import { IsInt, IsString, Min, MinLength } from 'class-validator';
export class SubmissionPreviewDto {
  @IsString() @MinLength(1) segment_id: string;
  @IsString() @MinLength(1) video_id: string;
  @IsInt() @Min(0) start_ms: number;
  @IsInt() @Min(1) end_ms: number;
}
