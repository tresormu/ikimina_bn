import { IsString, IsNotEmpty, IsEmail, MinLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterLenderDto {
  @ApiProperty({ example: 'Bank of Kigali' })
  @IsString()
  @IsNotEmpty()
  institutionName: string;

  @ApiProperty({ example: 'BNR-12345' })
  @IsString()
  @IsNotEmpty()
  licenseNumber: string;

  @ApiProperty({ example: 'contact@bk.rw' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(6)
  password: string;
}

export class LoginLenderDto {
  @ApiProperty({ example: 'contact@bk.rw' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(6)
  password: string;
}

export class SearchMemberDto {
  @ApiProperty({ example: '+250788123456' })
  @IsString()
  @IsNotEmpty()
  query: string;
}

export class UpdateLenderProfileDto {
  @ApiPropertyOptional({ example: 'contact@bk.rw' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ example: 'newpassword123' })
  @IsString()
  @MinLength(6)
  @IsOptional()
  password?: string;

  @ApiPropertyOptional({ example: 'Bank of Kigali Ltd' })
  @IsString()
  @IsOptional()
  institutionName?: string;
}

export class FlagReportDto {
  @ApiProperty({ example: 'Score appears inflated — member has no verifiable contributions' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
