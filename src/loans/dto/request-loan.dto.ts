import { IsString, IsNotEmpty, IsNumber, Min, IsOptional, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RequestLoanDto {
  @ApiProperty({ example: 'groupId-uuid' })
  @IsString()
  @IsNotEmpty()
  groupId: string;

  @ApiProperty({ example: 50000 })
  @IsNumber()
  @Min(1000)
  amount: number;

  @ApiProperty({ example: 'Emergency medical bill' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({ example: 3, description: 'Number of months to repay' })
  @IsNumber()
  @Min(1)
  @Max(24)
  @IsOptional()
  repaymentMonths?: number;
}
