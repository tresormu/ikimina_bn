import { IsString, IsNotEmpty, IsNumber, IsEnum, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { GroupFrequency } from '@prisma/client';

export class CreateGroupDto {
  @ApiProperty({ example: 'Kigali Savers' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 10000 })
  @IsNumber()
  contributionAmount: number;

  @ApiProperty({ enum: GroupFrequency })
  @IsEnum(GroupFrequency)
  frequency: GroupFrequency;

  @ApiProperty({ type: [String], description: 'Array of user IDs for initial rotation order' })
  @IsArray()
  @IsString({ each: true })
  initialRotationOrder: string[];
}
