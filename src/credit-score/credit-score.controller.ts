import { Controller, Get, Post, Delete, Param, Req, UseGuards } from '@nestjs/common';
import { CreditScoreService } from './credit-score.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Credit Score')
@Controller('credit-score')
export class CreditScoreController {
  constructor(private readonly creditScoreService: CreditScoreService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Get current credit score and breakdown' })
  getMyScore(@CurrentUser() user: { id: string }) {
    return this.creditScoreService.getMyScore(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('history/me')
  @ApiOperation({ summary: 'Get score history' })
  getMyHistory(@CurrentUser() user: { id: string }) {
    return this.creditScoreService.getMyHistory(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('report/me')
  @ApiOperation({ summary: 'Get full credit report' })
  getMyReport(@CurrentUser() user: { id: string }) {
    return this.creditScoreService.getMyReport(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('report/share')
  @ApiOperation({ summary: 'Generate shareable link for credit report' })
  shareReport(@CurrentUser() user: { id: string }) {
    return this.creditScoreService.shareReport(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete('report/share/:linkId')
  @ApiOperation({ summary: 'Revoke shareable link' })
  revokeShare(@Param('linkId') linkId: string, @CurrentUser() user: { id: string }) {
    return this.creditScoreService.revokeShare(linkId, user.id);
  }

  @Public()
  @Get('report/shared/:token')
  @ApiOperation({ summary: 'Publicly access a shared credit report' })
  getSharedReport(@Param('token') token: string, @Req() req: any) {
    const ip = (req.ip ?? req.socket?.remoteAddress ?? 'unknown') as string;
    return this.creditScoreService.getSharedReport(token, ip);
  }
}