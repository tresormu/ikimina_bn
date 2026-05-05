import { IsString, IsOptional, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class SubmitContributionDto {
  @ApiPropertyOptional({ example: 'TX123456789' })
  @IsString()
  @IsOptional()
  momoTransactionId?: string;

  @ApiPropertyOptional({ example: 'BNK-REF-001' })
  @IsString()
  @IsOptional()
  bankReference?: string;
}
