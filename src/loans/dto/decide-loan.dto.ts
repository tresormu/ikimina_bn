import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class DecideLoanDto {
  @ApiProperty({ example: 'APPROVED', enum: ['APPROVED', 'DECLINED'] })
  @IsString()
  @IsNotEmpty()
  @IsIn(['APPROVED', 'DECLINED'])
  decision: 'APPROVED' | 'DECLINED';

  @ApiProperty({ example: 'Approved after internal staff review', required: false })
  @IsString()
  @IsOptional()
  note?: string;
}
