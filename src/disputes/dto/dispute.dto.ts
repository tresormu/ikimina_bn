import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDisputeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @ApiProperty()
  @IsNumber()
  weekNumber: number;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  claimDescription: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  momoReference?: string;
}

export class ResolveDisputeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  resolutionNote: string;
}
