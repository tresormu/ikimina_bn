import { IsNotEmpty, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RepayLoanDto {
  @ApiProperty({ example: 50000 })
  @IsNumber()
  @Min(100)
  @IsNotEmpty()
  amount: number;
}
