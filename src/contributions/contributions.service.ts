import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubmitContributionDto } from './dto/submit-contribution.dto';
import { SubmitSharesDto } from './dto/submit-shares.dto';
import { ContributionStatus, GroupFrequency, NotificationChannel, NotificationType } from '@prisma/client';
import { Cron } from '@nestjs/schedule';

const BATCH_SIZE = 500;

@Injectable()
export class ContributionsService {
  private readonly logger = new Logger(ContributionsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async getCurrentOwed(groupId: string, userId: string) {
    await this.ensureActiveMember(groupId, userId);
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { rotationLogs: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });

    if (!group) throw new NotFoundException('Group not found');

    const currentWeek = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);

    const lastRotation = group.rotationLogs[0];
    const orderArray = lastRotation ? (lastRotation.newOrder as string[]) : [];
    const recipientId = orderArray[group.rotationIndex % orderArray.length];

    let recipientDetails: { name: string | null; phone: string } | null = null;
    if (recipientId) {
      const u = await this.prisma.user.findUnique({ where: { id: recipientId } });
      if (u) recipientDetails = { name: u.fullName, phone: u.phoneNumber };
    }

    const contribution = await this.prisma.contribution.findFirst({
      where: { groupId, userId, weekNumber: currentWeek },
    });

    let shareInfo: { sharePrice: number; maxShares: number } | null = null;
    if (group.contributionModel === 'FLEXIBLE_SHARES') {
      shareInfo = { sharePrice: group.sharePrice ?? 0, maxShares: group.maxSharesPerMember ?? 1 };
    }

    return {
      amountOwed: group.contributionAmount,
      weekNumber: currentWeek,
      recipient: recipientDetails,
      paymentStatus: contribution ? contribution.status : ContributionStatus.PENDING,
      contributionId: contribution?.id,
      shareInfo,
    };
  }

  async submit(groupId: string, userId: string, dto: SubmitContributionDto) {
    await this.ensureActiveMember(groupId, userId);
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    if (group.isSuspended) throw new BadRequestException('Group is suspended. Contributions are not accepted.');

    const currentWeek = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);

    // Duplicate TxID check
    if (dto.momoTransactionId) {
      const duplicate = await this.prisma.contribution.findFirst({
        where: { momoTransactionId: dto.momoTransactionId },
      });
      if (duplicate) throw new BadRequestException('This transaction ID has already been submitted.');
    }

    // Already submitted this period
    const existing = await this.prisma.contribution.findFirst({
      where: { groupId, userId, weekNumber: currentWeek, status: { not: ContributionStatus.MISSED } },
    });
    if (existing) throw new BadRequestException('You have already submitted a contribution for this period.');

    let amount = group.contributionAmount ?? 0;
    if (group.contributionModel === 'FIXED_SPLIT') {
      amount = (group.rotatingAmount ?? 0) + (group.savingsAmount ?? 0);
    }

    const contribution = await this.prisma.contribution.create({
      data: {
        groupId,
        userId,
        weekNumber: currentWeek,
        amount,
        status: ContributionStatus.PENDING,
        momoTransactionId: dto.momoTransactionId,
        bankReference: dto.bankReference,
      },
    });

    // Notify treasurer — outside transaction, non-critical
    const treasurer = await this.prisma.groupMember.findFirst({
      where: { groupId, role: 'TREASURER', isActive: true },
    });
    if (treasurer) {
      const member = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.CONTRIBUTION_CONFIRMED,
        `${member?.fullName ?? 'A member'} submitted contribution for period ${currentWeek}. Awaiting your confirmation.`,
        NotificationChannel.PUSH,
      );
    }

    return { message: 'Contribution submitted, awaiting treasurer confirmation.', contribution };
  }

  async confirmContribution(contributionId: string, treasurerId: string) {
    // Load contribution first to check it exists and get group info
    const contribution = await this.prisma.contribution.findUnique({
      where: { id: contributionId },
      include: { group: true },
    });
    if (!contribution) throw new NotFoundException('Contribution not found');

    await this.ensureTreasurer(contribution.groupId, treasurerId);

    // All financial state changes in a single atomic transaction.
    // The status-guard on the update (status: { in: [...] }) acts as a DB-level
    // concurrency lock — a second concurrent confirm will update 0 rows and throw.
    let updatedContribution: typeof contribution;

    try {
      updatedContribution = await this.prisma.$transaction(async (tx) => {
        // Atomic status transition — rejects if already VERIFIED (double-click safe)
        const updated = await tx.contribution.updateMany({
          where: {
            id: contributionId,
            status: { in: [ContributionStatus.PENDING, ContributionStatus.LATE] },
          },
          data: {
            status: ContributionStatus.VERIFIED,
            verifiedAt: new Date(),
            verifiedById: treasurerId,
          },
        });

        if (updated.count === 0) {
          throw new BadRequestException('Contribution is not in a confirmable state (already verified or disputed).');
        }

        // For ASCA / Hybrid groups: credit fund balance
        const isAccumulatingGroup =
          contribution.group.contributionModel === 'FLEXIBLE_SHARES' ||
          contribution.group.groupType === 'HYBRID_ROTATING_SAVINGS' ||
          contribution.group.groupType === 'ACCUMULATING_SHARES';

        if (isAccumulatingGroup) {
          const savingsAmount =
            contribution.group.groupType === 'HYBRID_ROTATING_SAVINGS'
              ? (contribution.group.savingsAmount ?? 0)
              : contribution.amount;

          await tx.groupFund.upsert({
            where: { groupId: contribution.groupId },
            update: { totalBalance: { increment: savingsAmount }, lastUpdated: new Date() },
            create: { groupId: contribution.groupId, totalBalance: savingsAmount },
          });

          // For FLEXIBLE_SHARES: mint shares now that payment is confirmed
          if (
            contribution.group.contributionModel === 'FLEXIBLE_SHARES' &&
            contribution.sharesCount != null &&
            contribution.sharesCount > 0
          ) {
            await tx.memberShareBalance.upsert({
              where: { groupId_memberId: { groupId: contribution.groupId, memberId: contribution.userId } },
              update: {
                totalShares: { increment: contribution.sharesCount },
                currentPeriodShares: contribution.sharesCount,
                lastUpdated: new Date(),
              },
              create: {
                groupId: contribution.groupId,
                memberId: contribution.userId,
                totalShares: contribution.sharesCount,
                currentPeriodShares: contribution.sharesCount,
              },
            });

            await tx.groupFund.update({
              where: { groupId: contribution.groupId },
              data: { totalShares: { increment: contribution.sharesCount }, lastUpdated: new Date() },
            });
          }
        }

        // Re-fetch to return the updated record
        return tx.contribution.findUniqueOrThrow({ 
          where: { id: contributionId },
          include: { group: true }
        });
      });
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('Failed to confirm contribution. Please try again.');
    }

    // Notify member — after transaction commits, never inside it
    await this.notifications.sendNotification(
      contribution.userId,
      NotificationType.CONTRIBUTION_CONFIRMED,
      `Your contribution of ${contribution.amount} RWF for period ${contribution.weekNumber} has been confirmed.`,
      NotificationChannel.SMS,
    );

    return { message: 'Contribution verified.', contribution: updatedContribution };
  }

  async resubmit(contributionId: string, userId: string, dto: SubmitContributionDto) {
    const contribution = await this.prisma.contribution.findUnique({ where: { id: contributionId } });

    if (!contribution || contribution.userId !== userId) {
      throw new NotFoundException('Contribution not found');
    }

    await this.ensureActiveMember(contribution.groupId, userId);

    if (contribution.status === ContributionStatus.VERIFIED) {
      throw new BadRequestException('Contribution already verified');
    }

    if (dto.momoTransactionId) {
      const duplicate = await this.prisma.contribution.findFirst({
        where: { momoTransactionId: dto.momoTransactionId, id: { not: contributionId } },
      });
      if (duplicate) throw new BadRequestException('This transaction ID has already been submitted.');
    }

    const updated = await this.prisma.contribution.update({
      where: { id: contributionId },
      data: {
        status: ContributionStatus.PENDING,
        momoTransactionId: dto.momoTransactionId,
        bankReference: dto.bankReference,
        failureReason: null,
      },
    });

    return { message: 'Contribution resubmitted, awaiting treasurer confirmation.', contribution: updated };
  }

  async getMyHistory(userId: string) {
    return this.prisma.contribution.findMany({
      where: { userId },
      include: { group: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // submitShares ONLY records the member's intent (sharesCount, shareValue, amount).
  // Actual share minting happens in confirmContribution once payment is verified.
  async submitShares(contributionId: string, userId: string, dto: SubmitSharesDto) {
    const contribution = await this.prisma.contribution.findUnique({
      where: { id: contributionId },
      include: { group: true },
    });

    if (!contribution || contribution.userId !== userId) {
      throw new NotFoundException('Contribution not found');
    }

    if (contribution.group.contributionModel !== 'FLEXIBLE_SHARES') {
      throw new BadRequestException('This group does not use flexible shares');
    }

    if (contribution.status !== ContributionStatus.PENDING) {
      throw new BadRequestException('Shares can only be set on a PENDING contribution.');
    }

    const sharePrice = contribution.group.sharePrice ?? 0;
    const maxShares = contribution.group.maxSharesPerMember ?? 1;

    if (dto.sharesCount < 1) throw new BadRequestException('Minimum 1 share required');
    if (dto.sharesCount > maxShares) throw new BadRequestException(`Maximum shares per period is ${maxShares}`);

    const amount = dto.sharesCount * sharePrice;

    // Only update the contribution record — no share allocation yet
    return this.prisma.contribution.update({
      where: { id: contributionId },
      data: { sharesCount: dto.sharesCount, shareValue: sharePrice, amount },
    });
  }

  async getMemberShareBalance(groupId: string, userId: string) {
    await this.ensureActiveMember(groupId, userId);

    const [balance, fund] = await Promise.all([
      this.prisma.memberShareBalance.findUnique({
        where: { groupId_memberId: { groupId, memberId: userId } },
      }),
      this.prisma.groupFund.findUnique({ where: { groupId } }),
    ]);

    const ownershipPct =
      fund && fund.totalShares > 0 && balance
        ? ((balance.totalShares / fund.totalShares) * 100).toFixed(2)
        : '0.00';

    const projectedPayout =
      fund && fund.totalShares > 0 && balance
        ? Math.floor((balance.totalShares / fund.totalShares) * (fund.totalBalance + fund.totalInterestEarned))
        : 0;

    return {
      totalShares: balance?.totalShares ?? 0,
      currentPeriodShares: balance?.currentPeriodShares ?? 0,
      ownershipPercentage: `${ownershipPct}%`,
      projectedPayout,
      groupTotalShares: fund?.totalShares ?? 0,
      groupFundBalance: fund?.totalBalance ?? 0,
    };
  }

  async getContributionsForPeriod(groupId: string, periodNumber: number, userId: string) {
    await this.ensureActiveMember(groupId, userId);
    return this.prisma.contribution.findMany({
      where: { groupId, weekNumber: periodNumber },
      include: { user: { select: { fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getGroupHistory(groupId: string, userId: string) {
    await this.ensureActiveMember(groupId, userId);
    return this.prisma.contribution.findMany({
      where: { groupId },
      include: { user: { select: { fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async ensureActiveMember(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!membership || !membership.isActive) {
      throw new ForbiddenException('You must be an active member of this group');
    }
  }

  private async ensureTreasurer(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!membership || membership.role !== 'TREASURER' || !membership.isActive) {
      throw new ForbiddenException('Treasurer access required');
    }
  }

  calculateCurrentCycleWeek(groupCreatedAt: Date, frequency: GroupFrequency): number {
    const elapsedMs = Math.max(0, Date.now() - groupCreatedAt.getTime());
    const cycleDays =
      frequency === GroupFrequency.WEEKLY ? 7 :
      frequency === GroupFrequency.BIWEEKLY ? 14 : 30;
    return Math.floor(elapsedMs / (cycleDays * 24 * 60 * 60 * 1000)) + 1;
  }

  // Every Sunday at 23:00 — mark contributions as MISSED if deadline passed
  // Uses cursor-based pagination to avoid loading all groups into memory at once
  @Cron('0 23 * * 0')
  async checkMissedContributions() {
    this.logger.log('Checking for missed contributions...');
    let cursor: string | undefined;

    while (true) {
      const groups = await this.prisma.group.findMany({
        where: { isSuspended: false, deletedAt: null },
        select: {
          id: true,
          createdAt: true,
          frequency: true,
          gracePeriodDays: true,
          contributionAmount: true,
          members: { where: { isActive: true }, select: { userId: true } },
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (groups.length === 0) break;

      for (const group of groups) {
        const currentWeek = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);

        for (const member of group.members) {
          const contribution = await this.prisma.contribution.findFirst({
            where: { groupId: group.id, userId: member.userId, weekNumber: currentWeek },
          });

          if (!contribution) {
            await this.prisma.contribution.create({
              data: {
                groupId: group.id,
                userId: member.userId,
                weekNumber: currentWeek,
                amount: group.contributionAmount ?? 0,
                status: ContributionStatus.MISSED,
              },
            });

            await this.notifications.sendNotification(
              member.userId,
              NotificationType.MISSED_PAYMENT,
              `You missed your contribution for period ${currentWeek}. This affects your credit score.`,
              NotificationChannel.SMS,
            );
          } else if (contribution.status === ContributionStatus.PENDING) {
            const graceDays = group.gracePeriodDays ?? 3;
            const deadlinePassed =
              Date.now() - contribution.createdAt.getTime() > graceDays * 24 * 60 * 60 * 1000;

            if (deadlinePassed) {
              await this.prisma.contribution.update({
                where: { id: contribution.id },
                data: { status: ContributionStatus.LATE },
              });
            }
          }
        }
      }

      cursor = groups[groups.length - 1].id;
      if (groups.length < BATCH_SIZE) break;
    }
  }

  // Every hour — auto-escalate contributions pending treasurer confirmation for 48h
  // Uses cursor-based pagination to avoid OOM on large datasets
  @Cron('0 * * * *')
  async autoEscalatePendingContributions() {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    let cursor: string | undefined;

    while (true) {
      const stale = await this.prisma.contribution.findMany({
        where: { status: ContributionStatus.PENDING, createdAt: { lt: cutoff } },
        select: {
          id: true,
          groupId: true,
          userId: true,
          weekNumber: true,
          momoTransactionId: true,
          bankReference: true,
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (stale.length === 0) break;

      for (const c of stale) {
        const existingDispute = await this.prisma.dispute.findFirst({
          where: {
            groupId: c.groupId,
            raiserId: c.userId,
            weekNumber: c.weekNumber,
            disputeType: 'CONTRIBUTION_NOT_RECORDED',
          },
        });

        if (!existingDispute) {
          await this.prisma.dispute.create({
            data: {
              groupId: c.groupId,
              raiserId: c.userId,
              weekNumber: c.weekNumber,
              disputeType: 'CONTRIBUTION_NOT_RECORDED',
              claimDescription: 'Auto-escalated: contribution pending confirmation for over 48 hours.',
              momoReference: c.momoTransactionId ?? c.bankReference,
            },
          });
        }
      }

      cursor = stale[stale.length - 1].id;
      if (stale.length < BATCH_SIZE) break;
    }
  }
}
