import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AssignPenaltyDto {
  @ApiProperty({ example: 'user-uuid' })
  @IsString()
  @IsNotEmpty()
  userId: string;

  @ApiProperty({ example: 'penalty-rule-uuid' })
  @IsString()
  @IsNotEmpty()
  penaltyRuleId: string;

  @ApiProperty({ example: 'Second late payment this month', required: false })
  @IsString()
  @IsOptional()
  note?: string;
}
