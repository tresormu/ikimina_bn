import { IsString, IsOptional, IsNumber, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { GroupFrequency } from '@prisma/client';

export class UpdateGroupDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  contributionAmount?: number;

  @ApiPropertyOptional({ enum: GroupFrequency })
  @IsEnum(GroupFrequency)
  @IsOptional()
  frequency?: GroupFrequency;
}
