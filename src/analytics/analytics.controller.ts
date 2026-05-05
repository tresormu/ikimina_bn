import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('group/:id')
  @ApiOperation({ summary: 'Get group analytics (treasurer or member)' })
  getGroupAnalytics(@Param('id') groupId: string, @CurrentUser() user: User) {
    return this.analyticsService.getGroupAnalytics(groupId, user.id);
  }

  @Get('member/:memberId')
  @ApiOperation({ summary: 'Get member analytics (self or treasurer of shared group)' })
  getMemberAnalytics(@Param('memberId') memberId: string, @CurrentUser() user: User) {
    return this.analyticsService.getMemberAnalytics(memberId, user.id);
  }

  @Get('platform')
  @ApiOperation({ summary: 'Get platform-wide analytics (Admin only)' })
  getPlatformAnalytics(@CurrentUser() user: User) {
    return this.analyticsService.getPlatformAnalytics(user.id);
  }
}
