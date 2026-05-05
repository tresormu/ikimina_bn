import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { User } from '@prisma/client';

@ApiTags('Subscriptions')
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Public()
  @Get('tiers')
  @ApiOperation({ summary: 'List all subscription tiers and prices' })
  getTiers() {
    return this.subscriptionsService.getTiers();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('group/:groupId')
  @ApiOperation({ summary: 'Get current subscription status for a group' })
  getGroupSubscription(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.subscriptionsService.getGroupSubscription(groupId, user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Get('group/:groupId/history')
  @ApiOperation({ summary: 'Get full billing history' })
  getSubscriptionHistory(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.subscriptionsService.getSubscriptionHistory(groupId, user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('group/:groupId/pay')
  @ApiOperation({ summary: 'Manually trigger payment for overdue account' })
  manualPay(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.subscriptionsService.manualPay(groupId, user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('referral/my-code')
  @ApiOperation({ summary: 'Get or generate your personal referral code' })
  getMyReferralCode(@CurrentUser() user: User) {
    return this.subscriptionsService.getMyReferralCode(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('referral/my-referrals')
  @ApiOperation({ summary: 'View all referrals you have made and their reward status' })
  getMyReferrals(@CurrentUser() user: User) {
    return this.subscriptionsService.getMyReferrals(user.id);
  }
}
