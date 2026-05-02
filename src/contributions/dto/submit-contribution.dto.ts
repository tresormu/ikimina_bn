import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SubmitContributionDto {
  @ApiProperty({ example: 'TX123456789' })
  @IsString()
  @IsNotEmpty()
  momoTransactionId: string;
}
