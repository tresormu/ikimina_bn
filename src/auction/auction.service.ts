import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubmitBidDto } from './dto/submit-bid.dto';
import { GroupFrequency, NotificationChannel, NotificationType } from '@prisma/client';
import { Cron } from '@nestjs/schedule';
import { Logger } from '@nestjs/common';

@Injectable()
export class AuctionService {
  private readonly logger = new Logger(AuctionService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  private calculateCurrentCycleWeek(groupCreatedAt: Date, frequency: GroupFrequency): number {
    const elapsedMs = Math.max(0, Date.now() - groupCreatedAt.getTime());
    const cycleDays =
      frequency === GroupFrequency.WEEKLY ? 7 :
      frequency === GroupFrequency.BIWEEKLY ? 14 : 30;
    return Math.floor(elapsedMs / (cycleDays * 24 * 60 * 60 * 1000)) + 1;
  }

  private getBiddingWindowEnd(group: { createdAt: Date; frequency: GroupFrequency; auctionWindowHours: number | null }): Date {
    // Window opens at the start of the current period, closes after auctionWindowHours
    const cycleDays =
      group.frequency === GroupFrequency.WEEKLY ? 7 :
      group.frequency === GroupFrequency.BIWEEKLY ? 14 : 30;
    const currentWeek = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);
    const periodStart = new Date(group.createdAt.getTime() + (currentWeek - 1) * cycleDays * 24 * 60 * 60 * 1000);
    const windowHours = group.auctionWindowHours ?? 24;
    return new Date(periodStart.getTime() + windowHours * 60 * 60 * 1000);
  }

  async submitBid(groupId: string, userId: string, dto: SubmitBidDto) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { members: { where: { isActive: true } } },
    });

    if (!group) throw new NotFoundException('Group not found');

    const membership = group.members.find((m) => m.userId === userId);
    if (!membership) throw new ForbiddenException('You must be an active member to bid');
    if (group.rotationType !== 'AUCTION') throw new BadRequestException('This group does not use auction rotation');

    const periodNumber = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);

    // Check bidding window is still open
    const windowEnd = this.getBiddingWindowEnd(group as any);
    if (new Date() > windowEnd) {
      throw new BadRequestException('Bidding window for this period has closed.');
    }

    // Check member has not already won in this cycle
    const cycleStart = Math.floor((periodNumber - 1) / group.members.length) * group.members.length + 1;
    const alreadyWon = await this.prisma.auctionBid.findFirst({
      where: {
        groupId,
        memberId: userId,
        isWinning: true,
        periodNumber: { gte: cycleStart, lt: periodNumber },
      },
    });
    if (alreadyWon) {
      throw new BadRequestException('You have already received the pot in this cycle and cannot bid again.');
    }

    // Minimum bid validation
    if (group.minBidPercentage && group.contributionAmount) {
      const fullPot = group.contributionAmount * group.members.length;
      const minBid = Math.floor((group.minBidPercentage / 100) * fullPot);
      if (dto.bidAmount < minBid) {
        throw new BadRequestException(`Bid must be at least ${minBid} RWF (${group.minBidPercentage}% of pot)`);
      }
    }

    // Upsert bid (member can update while window is open)
    const existingBid = await this.prisma.auctionBid.findFirst({
      where: { groupId, memberId: userId, periodNumber },
    });

    if (existingBid) {
      return this.prisma.auctionBid.update({
        where: { id: existingBid.id },
        data: { bidAmount: dto.bidAmount, submittedAt: new Date() },
      });
    }

    return this.prisma.auctionBid.create({
      data: { groupId, memberId: userId, periodNumber, bidAmount: dto.bidAmount },
    });
  }

  async getAuctionStatus(groupId: string, userId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { members: { where: { isActive: true } } },
    });

    if (!group) throw new NotFoundException('Group not found');
    if (!group.members.find((m) => m.userId === userId)) throw new ForbiddenException('Not a member');

    const periodNumber = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);
    const windowEnd = this.getBiddingWindowEnd(group as any);
    const isOpen = new Date() <= windowEnd;

    // Sealed auction — only show own bid
    const myBid = await this.prisma.auctionBid.findFirst({
      where: { groupId, memberId: userId, periodNumber },
    });

    const bidCount = await this.prisma.auctionBid.count({
      where: { groupId, periodNumber },
    });

    return {
      periodNumber,
      isOpen,
      windowClosesAt: windowEnd,
      myBid: myBid ? myBid.bidAmount : null,
      submittedAt: myBid ? myBid.submittedAt : null,
      totalBidsSubmitted: bidCount,
    };
  }

  async getAuctionHistory(groupId: string, userId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { members: { where: { userId, isActive: true } } },
    });

    if (!group) throw new NotFoundException('Group not found');
    if (group.members.length === 0) throw new ForbiddenException('Not a member');

    return this.prisma.auctionBid.findMany({
      where: { groupId, isWinning: true },
      include: { member: { select: { fullName: true } } },
      orderBy: { periodNumber: 'desc' },
    });
  }

  // Resolve auction when bidding window closes — runs every hour
  @Cron('0 * * * *')
  async resolveExpiredAuctions() {
    const auctionGroups = await this.prisma.group.findMany({
      where: { rotationType: 'AUCTION', isSuspended: false },
      include: { members: { where: { isActive: true }, select: { userId: true } } },
    });

    for (const group of auctionGroups) {
      const periodNumber = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);
      const windowEnd = this.getBiddingWindowEnd(group as any);

      if (new Date() <= windowEnd) continue; // window still open

      // Check if already resolved
      const alreadyResolved = await this.prisma.auctionBid.findFirst({
        where: { groupId: group.id, periodNumber, isWinning: true },
      });
      if (alreadyResolved) continue;

      const bids = await this.prisma.auctionBid.findMany({
        where: { groupId: group.id, periodNumber },
        orderBy: [{ bidAmount: 'asc' }, { submittedAt: 'asc' }],
      });

      if (bids.length === 0) {
        // No bids — fall back to sequential rotation
        this.logger.log(`Group ${group.id} period ${periodNumber}: no bids, falling back to sequential`);
        continue;
      }

      const winner = bids[0]; // lowest bid, earliest submission wins ties
      const fullPot = (group.contributionAmount ?? 0) * group.members.length;
      const surplus = fullPot - winner.bidAmount;
      const surplusPerMember =
        group.members.length > 1 ? Math.floor(surplus / (group.members.length - 1)) : 0;

      await this.prisma.$transaction(async (tx) => {
        // Mark winner
        await tx.auctionBid.update({
          where: { id: winner.id },
          data: { isWinning: true },
        });

        // Record payout event
        await tx.activityFeedEvent.create({
          data: {
            groupId: group.id,
            type: 'AUCTION_RESOLVED',
            data: {
              periodNumber,
              winnerId: winner.memberId,
              winningBid: winner.bidAmount,
              fullPot,
              surplus,
              surplusPerMember,
            },
          },
        });
      });

      // Notify winner
      await this.notifications.sendNotification(
        winner.memberId,
        NotificationType.YOUR_TURN,
        `You won the auction for period ${periodNumber}! You will receive ${winner.bidAmount} RWF.`,
        NotificationChannel.SMS,
      );

      // Notify other members of their dividend
      if (surplusPerMember > 0) {
        const others = group.members.filter((m) => m.userId !== winner.memberId);
        await Promise.all(
          others.map((m) =>
            this.notifications.sendNotification(
              m.userId,
              NotificationType.PAYOUT_SCHEDULED,
              `Auction resolved for period ${periodNumber}. Your dividend: ${surplusPerMember} RWF.`,
              NotificationChannel.SMS,
            ),
          ),
        );
      }
    }
  }
}
