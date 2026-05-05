import { IsArray, IsString, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RotationType } from '@prisma/client';

export class UpdateRotationDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  newOrder: string[];

  @ApiPropertyOptional({ enum: RotationType })
  @IsEnum(RotationType)
  @IsOptional()
  rotationType?: RotationType;
}
