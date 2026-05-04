import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreatePenaltyRuleDto {
  @ApiProperty({ example: 'Late contribution' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Member missed weekly payment window', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 2000 })
  @IsNumber()
  @Min(1)
  amount: number;
}
