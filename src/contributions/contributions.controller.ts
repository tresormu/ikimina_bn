import { Controller, Get, Post, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ContributionsService } from './contributions.service';
import { SubmitContributionDto } from './dto/submit-contribution.dto';
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
  @ApiOperation({ summary: 'Get current week amount owed and recipient' })
  getCurrentOwed(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.contributionsService.getCurrentOwed(groupId, user.id);
  }

  @Post('submit/:groupId')
  @ApiOperation({ summary: 'Submit MoMo transaction ID for current week' })
  submit(@Param('groupId') groupId: string, @CurrentUser() user: User, @Body() dto: SubmitContributionDto) {
    return this.contributionsService.submit(groupId, user.id, dto);
  }

  @Patch(':id/resubmit')
  @ApiOperation({ summary: 'Resubmit failed MoMo transaction' })
  resubmit(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: SubmitContributionDto) {
    return this.contributionsService.resubmit(id, user.id, dto);
  }

  @Get('history/me')
  @ApiOperation({ summary: 'Get personal contribution history' })
  getMyHistory(@CurrentUser() user: User) {
    return this.contributionsService.getMyHistory(user.id);
  }

  @Get('history/group/:groupId')
  @ApiOperation({ summary: 'Get full group contribution history' })
  getGroupHistory(@Param('groupId') groupId: string) {
    return this.contributionsService.getGroupHistory(groupId);
  }
}
