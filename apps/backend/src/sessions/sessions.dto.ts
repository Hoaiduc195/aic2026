import { IsString, MaxLength, MinLength } from 'class-validator';
export class CreateSessionDto { @IsString() @MinLength(1) @MaxLength(2000) query: string; }
export class RefineSessionDto { @IsString() @MinLength(1) @MaxLength(500) refinement: string; }
