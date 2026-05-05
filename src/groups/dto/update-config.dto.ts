import { IsEnum, IsNumber, IsOptional, IsBoolean, IsArray, IsString } from 'class-validator';
import { GroupType, ContributionModel, RotationType, PenaltyType, GroupLanguage, DisbursementType } from '@prisma/client';

export class UpdateConfigDto {
  @IsOptional() @IsEnum(GroupType) groupType?: GroupType;
  @IsOptional() @IsEnum(ContributionModel) contributionModel?: ContributionModel;
  @IsOptional() @IsNumber() contributionAmount?: number;
  @IsOptional() @IsNumber() rotatingAmount?: number;
  @IsOptional() @IsNumber() savingsAmount?: number;
  @IsOptional() @IsNumber() sharePrice?: number;
  @IsOptional() @IsNumber() maxSharesPerMember?: number;
  @IsOptional() @IsEnum(RotationType) rotationType?: RotationType;
  @IsOptional() @IsNumber() auctionWindowHours?: number;
  @IsOptional() @IsNumber() minBidPercentage?: number;
  @IsOptional() @IsBoolean() loansEnabled?: boolean;
  @IsOptional() @IsNumber() loanMinTenureMonths?: number;
  @IsOptional() @IsNumber() loanMaxPercentage?: number;
  @IsOptional() @IsNumber() loanInterestRate?: number;
  @IsOptional() @IsNumber() gracePeriodDays?: number;
  @IsOptional() @IsEnum(PenaltyType) latePenaltyType?: PenaltyType;
  @IsOptional() @IsNumber() latePenaltyAmount?: number;
  @IsOptional() @IsNumber() missesBeforeRemoval?: number;
  @IsOptional() @IsEnum(GroupLanguage) language?: GroupLanguage;
  @IsOptional() @IsArray() @IsString({ each: true }) emergencyCategories?: string[];
  @IsOptional() @IsEnum(DisbursementType) disbursementType?: DisbursementType;
  @IsOptional() @IsNumber() maxDisbursement?: number;
  @IsOptional() @IsString() sectorRegistered?: string;
  @IsOptional() @IsString() registrationNumber?: string;
}
