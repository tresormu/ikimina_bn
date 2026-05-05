import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ContributionsService } from './contributions.service';
import { SubmitContributionDto } from './dto/submit-contribution.dto';
import { SubmitSharesDto } from './dto/submit-shares.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Contributions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('contributions')
export class ContributionsController {
  constructor(private readonly contributionsService: ContributionsService) {}

  @Get('current/:groupId')
  @ApiOperation({ summary: 'Get current period amount owed and recipient' })
  getCurrentOwed(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.contributionsService.getCurrentOwed(groupId, user.id);
  }

  @Post('submit/:groupId')
  @ApiOperation({ summary: 'Submit MoMo transaction ID for current period' })
  submit(@Param('groupId') groupId: string, @CurrentUser() user: User, @Body() dto: SubmitContributionDto) {
    return this.contributionsService.submit(groupId, user.id, dto);
  }

  @Patch(':id/confirm')
  @ApiOperation({ summary: 'Treasurer confirms a pending contribution' })
  confirmContribution(@Param('id') id: string, @CurrentUser() user: User) {
    return this.contributionsService.confirmContribution(id, user.id);
  }

  @Patch(':id/resubmit')
  @ApiOperation({ summary: 'Resubmit a failed or pending contribution with new TxID' })
  resubmit(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: SubmitContributionDto) {
    return this.contributionsService.resubmit(id, user.id, dto);
  }

  @Post(':id/shares')
  @ApiOperation({ summary: 'Submit share count for flexible groups' })
  submitShares(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: SubmitSharesDto) {
    return this.contributionsService.submitShares(id, user.id, dto);
  }

  @Get('group/:groupId/period/:n')
  @ApiOperation({ summary: 'Get all contributions for period N' })
  getContributionsForPeriod(@Param('groupId') groupId: string, @Param('n') n: string, @CurrentUser() user: User) {
    return this.contributionsService.getContributionsForPeriod(groupId, parseInt(n, 10), user.id);
  }

  @Get('group/:groupId/share-balance')
  @ApiOperation({ summary: 'Get member share balance and projected payout in ASCA group' })
  getMemberShareBalance(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.contributionsService.getMemberShareBalance(groupId, user.id);
  }

  @Get('history/me')
  @ApiOperation({ summary: 'Get personal contribution history' })
  getMyHistory(@CurrentUser() user: User) {
    return this.contributionsService.getMyHistory(user.id);
  }

  @Get('history/group/:groupId')
  @ApiOperation({ summary: 'Get full group contribution history' })
  getGroupHistory(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.contributionsService.getGroupHistory(groupId, user.id);
  }
}
