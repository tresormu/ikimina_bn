import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsEnum,
  IsArray,
  IsOptional,
  IsBoolean,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  GroupFrequency,
  GroupType,
  ContributionModel,
  RotationType,
  PenaltyType,
  GroupLanguage,
  DisbursementType,
} from '@prisma/client';

export class CreateGroupDto {
  @ApiProperty({ example: 'Kigali Savers' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ enum: GroupFrequency })
  @IsEnum(GroupFrequency)
  frequency: GroupFrequency;

  @ApiPropertyOptional({ enum: GroupType, default: GroupType.ROTATING_EQUAL })
  @IsEnum(GroupType)
  @IsOptional()
  groupType?: GroupType;

  @ApiPropertyOptional({ enum: ContributionModel, default: ContributionModel.FIXED_EQUAL })
  @IsEnum(ContributionModel)
  @IsOptional()
  contributionModel?: ContributionModel;

  @ApiPropertyOptional({ example: 10000, description: 'For FIXED_EQUAL groups' })
  @IsNumber()
  @IsOptional()
  contributionAmount?: number;

  @ApiPropertyOptional({ example: 8000, description: 'For HYBRID groups — rotating pot portion' })
  @IsNumber()
  @IsOptional()
  rotatingAmount?: number;

  @ApiPropertyOptional({ example: 2000, description: 'For HYBRID groups — savings fund portion' })
  @IsNumber()
  @IsOptional()
  savingsAmount?: number;

  @ApiPropertyOptional({ example: 200, description: 'For FLEXIBLE_SHARES groups — minimum 200 RWF' })
  @IsNumber()
  @Min(200)
  @IsOptional()
  sharePrice?: number;

  @ApiPropertyOptional({ example: 50, description: 'For FLEXIBLE_SHARES groups' })
  @IsNumber()
  @Min(1)
  @IsOptional()
  maxSharesPerMember?: number;

  @ApiPropertyOptional({ enum: RotationType, default: RotationType.SEQUENTIAL })
  @IsEnum(RotationType)
  @IsOptional()
  rotationType?: RotationType;

  @ApiPropertyOptional({ example: 24, description: 'For AUCTION groups — bidding window in hours' })
  @IsNumber()
  @IsOptional()
  auctionWindowHours?: number;

  @ApiPropertyOptional({ example: 70, description: 'For AUCTION groups — minimum bid as % of pot' })
  @IsNumber()
  @IsOptional()
  minBidPercentage?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  loansEnabled?: boolean;

  @ApiPropertyOptional({ example: 6, default: 6 })
  @IsNumber()
  @IsOptional()
  loanMinTenureMonths?: number;

  @ApiPropertyOptional({ example: 30, default: 30, description: '% of fund' })
  @IsNumber()
  @IsOptional()
  loanMaxPercentage?: number;

  @ApiPropertyOptional({ example: 3, description: 'Monthly interest rate %' })
  @IsNumber()
  @IsOptional()
  loanInterestRate?: number;

  @ApiPropertyOptional({ example: 3, default: 3 })
  @IsNumber()
  @IsOptional()
  gracePeriodDays?: number;

  @ApiPropertyOptional({ enum: PenaltyType, default: PenaltyType.NONE })
  @IsEnum(PenaltyType)
  @IsOptional()
  latePenaltyType?: PenaltyType;

  @ApiPropertyOptional({ example: 500 })
  @IsNumber()
  @IsOptional()
  latePenaltyAmount?: number;

  @ApiPropertyOptional({ example: 3, default: 3 })
  @IsNumber()
  @IsOptional()
  missesBeforeRemoval?: number;

  @ApiPropertyOptional({ enum: GroupLanguage, default: GroupLanguage.KINYARWANDA })
  @IsEnum(GroupLanguage)
  @IsOptional()
  language?: GroupLanguage;

  @ApiPropertyOptional({ type: [String], example: ['DEATH', 'MEDICAL', 'DISASTER'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  emergencyCategories?: string[];

  @ApiPropertyOptional({ enum: DisbursementType })
  @IsEnum(DisbursementType)
  @IsOptional()
  disbursementType?: DisbursementType;

  @ApiPropertyOptional({ example: 50000 })
  @IsNumber()
  @IsOptional()
  maxDisbursement?: number;

  @ApiPropertyOptional({ example: 'Kicukiro Sector' })
  @IsString()
  @IsOptional()
  sectorRegistered?: string;

  @ApiPropertyOptional({ example: 'KIC-2024-001' })
  @IsString()
  @IsOptional()
  registrationNumber?: string;

  @ApiPropertyOptional({ example: 'ABCD1234', description: 'Referral code from an existing treasurer' })
  @IsString()
  @IsOptional()
  referredByCode?: string;

  @ApiPropertyOptional({ type: [String], description: 'Array of user IDs for initial rotation order' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  initialRotationOrder?: string[];
}
