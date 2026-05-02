import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApproveRejectLenderDto {
  @ApiPropertyOptional({ example: 'All documents verified' })
  @IsString()
  @IsOptional()
  note?: string;
}

export class RejectLenderDto {
  @ApiProperty({ example: 'License number invalid' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class SuspendGroupDto {
  @ApiProperty({ example: 'Fraudulent activity detected' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ResolveDisputeAdminDto {
  @ApiProperty({ example: 'Investigated and resolved in favour of member' })
  @IsString()
  @IsNotEmpty()
  resolutionNote: string;
}

export class PlatformAnnouncementDto {
  @ApiProperty({ example: 'IkiminaPass will be down for maintenance on Sunday.' })
  @IsString()
  @IsNotEmpty()
  message: string;
}

export class SearchUserDto {
  @ApiProperty({ example: 'John' })
  @IsString()
  @IsNotEmpty()
  query: string;
}

export class OverrideSubscriptionDto {
  @ApiProperty({ example: 'Manual override approved by CEO' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
