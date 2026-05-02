import { IsString, IsNotEmpty, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VoteLoanDto {
  @ApiProperty({ example: 'APPROVE', enum: ['APPROVE', 'DECLINE'] })
  @IsString()
  @IsNotEmpty()
  @IsIn(['APPROVE', 'DECLINE'])
  vote: string;
}
