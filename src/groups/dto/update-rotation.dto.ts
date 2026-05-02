import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateRotationDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  newOrder: string[];
}
