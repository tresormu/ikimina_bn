import { IsString, IsNotEmpty, IsNumber, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DisputeType } from '@prisma/client';

export class CreateDisputeDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @ApiProperty()
  @IsNumber()
  weekNumber: number;

  @ApiProperty({ enum: DisputeType, default: DisputeType.CONTRIBUTION_NOT_RECORDED })
  @IsEnum(DisputeType)
  disputeType: DisputeType;

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
