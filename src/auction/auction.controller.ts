import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { AuctionService } from './auction.service';
import { SubmitBidDto } from './dto/submit-bid.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Auction')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('groups/:id/auction')
export class AuctionController {
  constructor(private readonly auctionService: AuctionService) {}

  @Post('bid')
  @ApiOperation({ summary: 'Submit an auction bid for the current period' })
  submitBid(@Param('id') groupId: string, @CurrentUser() user: User, @Body() dto: SubmitBidDto) {
    return this.auctionService.submitBid(groupId, user.id, dto);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get current auction status' })
  getAuctionStatus(@Param('id') groupId: string, @CurrentUser() user: User) {
    return this.auctionService.getAuctionStatus(groupId, user.id);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get past auction results for the group' })
  getAuctionHistory(@Param('id') groupId: string, @CurrentUser() user: User) {
    return this.auctionService.getAuctionHistory(groupId, user.id);
  }
}
