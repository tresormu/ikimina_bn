import { IsString, IsNotEmpty, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

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
}
