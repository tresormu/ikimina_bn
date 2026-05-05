import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { UpdateRotationDto } from './dto/update-rotation.dto';
import { CreatePenaltyRuleDto } from './dto/create-penalty-rule.dto';
import { AssignPenaltyDto } from './dto/assign-penalty.dto';
import { UpdateConfigDto } from './dto/update-config.dto';
import { Role, NotificationType, NotificationChannel } from '@prisma/client';
import { randomInt } from 'crypto';

@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  private generateInviteCode(): string {
    // 6-digit numeric code — easy to type on button phones
    return randomInt(100000, 999999).toString();
  }

  private async generateUniqueInviteCode(): Promise<string> {
    for (let i = 0; i < 10; i++) {
      const code = this.generateInviteCode();
      const [g, c] = await Promise.all([
        this.prisma.group.findUnique({ where: { inviteCode: code }, select: { id: true } }),
        this.prisma.groupInviteCode.findUnique({ where: { code }, select: { id: true } }),
      ]);
      if (!g && !c) return code;
    }
    throw new BadRequestException('Failed to generate a unique invite code. Please try again.');
  }

  async createGroup(userId: string, dto: CreateGroupDto) {
    const inviteCode = await this.generateUniqueInviteCode();

    // Validate group-type-specific required fields
    if (
      (dto.groupType === 'ACCUMULATING_SHARES' || dto.groupType === 'INVESTMENT_CLUB') &&
      dto.contributionModel === 'FLEXIBLE_SHARES'
    ) {
      if (!dto.sharePrice || dto.sharePrice < 200) {
        throw new BadRequestException('sharePrice must be at least 200 RWF for flexible share groups');
      }
      if (!dto.maxSharesPerMember || dto.maxSharesPerMember < 1) {
        throw new BadRequestException('maxSharesPerMember is required for flexible share groups');
      }
    }

    if (dto.groupType === 'HYBRID_ROTATING_SAVINGS') {
      if (!dto.rotatingAmount || !dto.savingsAmount) {
        throw new BadRequestException('rotatingAmount and savingsAmount are required for hybrid groups');
      }
    }

    if (
      dto.groupType === 'ROTATING_EQUAL' ||
      dto.groupType === 'ROTATING_AUCTION' ||
      dto.groupType === 'SOLIDARITY_FUND'
    ) {
      if (!dto.contributionAmount) {
        throw new BadRequestException('contributionAmount is required for this group type');
      }
    }

    return this.prisma.$transaction(async (prisma) => {
      const group = await prisma.group.create({
        data: {
          name: dto.name,
          frequency: dto.frequency,
          inviteCode,
          groupType: dto.groupType ?? 'ROTATING_EQUAL',
          contributionModel: dto.contributionModel ?? 'FIXED_EQUAL',
          contributionAmount: dto.contributionAmount,
          rotatingAmount: dto.rotatingAmount,
          savingsAmount: dto.savingsAmount,
          sharePrice: dto.sharePrice,
          maxSharesPerMember: dto.maxSharesPerMember,
          rotationType: dto.rotationType ?? 'SEQUENTIAL',
          auctionWindowHours: dto.auctionWindowHours,
          minBidPercentage: dto.minBidPercentage,
          loansEnabled: dto.groupType === 'SOLIDARITY_FUND' ? false : (dto.loansEnabled ?? true),
          loanMinTenureMonths: dto.loanMinTenureMonths ?? 6,
          loanMaxPercentage: dto.loanMaxPercentage ?? 30,
          loanInterestRate: dto.loanInterestRate,
          gracePeriodDays: dto.gracePeriodDays ?? 3,
          latePenaltyType: dto.latePenaltyType ?? 'NONE',
          latePenaltyAmount: dto.latePenaltyAmount,
          missesBeforeRemoval: dto.missesBeforeRemoval ?? 3,
          language: dto.language ?? 'KINYARWANDA',
          emergencyCategories: dto.emergencyCategories ?? [],
          disbursementType: dto.disbursementType,
          maxDisbursement: dto.maxDisbursement,
          sectorRegistered: dto.sectorRegistered,
          registrationNumber: dto.registrationNumber,
          referredByCode: dto.referredByCode,
          members: { create: { userId, role: Role.TREASURER } },
        },
      });

      const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await prisma.groupSubscription.create({
        data: {
          groupId: group.id,
          tier: 'STARTER',
          memberCountAtBilling: 1,
          amountDue: 5000,
          billingDate: new Date(),
          status: 'TRIAL',
          trialEndsAt,
          nextBillingDate: trialEndsAt,
        },
      });

      await prisma.rotationLog.create({
        data: {
          groupId: group.id,
          actorId: userId,
          previousOrder: [],
          newOrder: dto.initialRotationOrder ?? [],
        },
      });

      // Create GroupFund for ASCA/Hybrid/Investment groups
      if (
        group.groupType === 'ACCUMULATING_SHARES' ||
        group.groupType === 'HYBRID_ROTATING_SAVINGS' ||
        group.groupType === 'INVESTMENT_CLUB'
      ) {
        await prisma.groupFund.create({ data: { groupId: group.id } });
      }

      // Record referral if a referral code was provided
      if (dto.referredByCode) {
        const referrer = await prisma.user.findUnique({
          where: { referralCode: dto.referredByCode },
          select: { id: true },
        });
        if (referrer && referrer.id !== userId) {
          await prisma.referralLog.create({
            data: {
              referrerId: referrer.id,
              referredUserId: userId,
              groupId: group.id,
              status: 'PENDING',
            },
          });
        }
      }

      return group;
    });
  }

  async previewGroup(inviteCode: string) {
    const group = await this.prisma.group.findUnique({
      where: { inviteCode },
      select: {
        id: true,
        name: true,
        contributionAmount: true,
        frequency: true,
        groupType: true,
        contributionModel: true,
        _count: { select: { members: true } },
      },
    });

    if (!group) throw new NotFoundException('Invalid invite code');
    return group;
  }

  async joinGroup(userId: string, inviteCode: string) {
    const timedCode = await this.prisma.groupInviteCode.findUnique({
      where: { code: inviteCode },
      include: { group: true },
    });

    let group: any;

    if (timedCode) {
      if (timedCode.expiresAt < new Date()) {
        throw new BadRequestException('This invite code has expired. Ask your treasurer to generate a new one.');
      }
      group = timedCode.group;
    } else {
      group = await this.prisma.group.findUnique({ where: { inviteCode } });
      if (!group) throw new NotFoundException('Invalid invite code');
    }

    if (group.isSuspended) throw new ForbiddenException('Group is currently suspended');

    const existingMember = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } },
    });

    if (existingMember) {
      if (!existingMember.isActive) {
        await this.prisma.groupMember.update({
          where: { id: existingMember.id },
          data: { isActive: true },
        });
        return { message: 'Rejoined group successfully' };
      }
      throw new BadRequestException('You are already a member of this group');
    }

    await this.prisma.groupMember.create({
      data: { groupId: group.id, userId, role: Role.MEMBER },
    });

    return { message: 'Joined group successfully' };
  }

  async regenerateInviteCode(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, name: true, isSuspended: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    if (group.isSuspended) throw new BadRequestException('Cannot regenerate code for a suspended group');

    const newCode = await this.generateUniqueInviteCode();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const [updatedGroup, inviteRecord] = await this.prisma.$transaction([
      this.prisma.group.update({
        where: { id: groupId },
        data: { inviteCode: newCode },
        select: { id: true, name: true, inviteCode: true },
      }),
      this.prisma.groupInviteCode.create({
        data: { groupId, code: newCode, expiresAt },
      }),
    ]);

    return {
      message: 'New invite code generated successfully',
      inviteCode: updatedGroup.inviteCode,
      expiresAt: inviteRecord.expiresAt,
      groupName: updatedGroup.name,
    };
  }

  async getUserGroups(userId: string) {
    return this.prisma.group.findMany({
      where: { members: { some: { userId, isActive: true } } },
      include: { members: { where: { userId } } },
    });
  }

  async getGroupDetails(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });

    if (!membership || !membership.isActive) throw new ForbiddenException('Not a member');

    const isTreasurer = membership.role === Role.TREASURER;

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                phoneNumber: true,
              },
            },
          },
        },
        subscriptions: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });

    // Mask phone number to last 4 digits for non-treasurers
    if (!isTreasurer && group?.members) {
      return {
        ...group,
        members: group.members.map((m) => ({
          ...m,
          user: {
            ...m.user,
            phoneNumber: m.user.phoneNumber
              ? `****${m.user.phoneNumber.slice(-4)}`
              : null,
          },
        })),
      };
    }

    return group;
  }

  async updateGroup(groupId: string, userId: string, dto: UpdateGroupDto) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.group.update({ where: { id: groupId }, data: dto });
  }

  async getGroupConfig(groupId: string, userId: string) {
    await this.ensureMember(groupId, userId);
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    return group;
  }

  async updateGroupConfig(groupId: string, userId: string, dto: UpdateConfigDto) {
    await this.ensureTreasurer(groupId, userId);

    return this.prisma.$transaction(async (prisma) => {
      const group = await prisma.group.update({ where: { id: groupId }, data: dto });

      await prisma.auditLog.create({
        data: {
          actorId: userId,
          actionType: 'UPDATE_GROUP_CONFIG',
          targetId: groupId,
          metadata: JSON.parse(JSON.stringify(dto)),
        },
      });

      return group;
    });
  }

  async getGroupHealth(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { members: { where: { isActive: true }, select: { userId: true, joinedAt: true } } },
    });
    if (!group) throw new NotFoundException('Group not found');

    const cycleDays =
      group.frequency === 'WEEKLY' ? 7 : group.frequency === 'BIWEEKLY' ? 14 : 30;
    const elapsedDays = Math.floor((Date.now() - group.createdAt.getTime()) / (24 * 60 * 60 * 1000));
    const currentWeek = Math.floor(elapsedDays / cycleDays) + 1;

    const totalMembers = group.members.length;

    // Payment health rate
    const verifiedThisPeriod = await this.prisma.contribution.count({
      where: { groupId, weekNumber: currentWeek, status: 'VERIFIED' },
    });
    const paymentHealthRate = totalMembers > 0 ? Math.round((verifiedThisPeriod / totalMembers) * 100) : 0;

    // Dispute rate per 100 transactions
    const [totalContributions, totalDisputes] = await Promise.all([
      this.prisma.contribution.count({ where: { groupId } }),
      this.prisma.dispute.count({ where: { groupId } }),
    ]);
    const disputeRate =
      totalContributions > 0 ? Math.round((totalDisputes / totalContributions) * 100) : 0;

    // Member retention rate — members who completed at least one full cycle
    const memberRetentionRate =
      totalMembers > 0
        ? Math.round(
            (group.members.filter(
              (m) => (Date.now() - m.joinedAt.getTime()) / (1000 * 60 * 60 * 24 * 30) >= 1,
            ).length /
              totalMembers) *
              100,
          )
        : 0;

    // Average credit score
    const scores = await this.prisma.creditScore.findMany({
      where: { userId: { in: group.members.map((m) => m.userId) } },
      select: { score: true },
    });
    const averageMemberScore =
      scores.length > 0 ? Math.round(scores.reduce((s, c) => s + c.score, 0) / scores.length) : 0;

    const groupHealthScore = Math.round(
      paymentHealthRate * 0.4 +
        (100 - disputeRate) * 0.2 +
        memberRetentionRate * 0.2 +
        (averageMemberScore / 850) * 100 * 0.2,
    );

    return {
      groupId,
      paymentHealthRate,
      disputeRate,
      memberRetentionRate,
      averageMemberScore,
      groupHealthScore: Math.min(100, groupHealthScore),
    };
  }

  async getGroupFund(groupId: string, userId: string) {
    await this.ensureMember(groupId, userId);

    let fund = await this.prisma.groupFund.findUnique({ where: { groupId } });
    if (!fund) {
      fund = await this.prisma.groupFund.create({ data: { groupId } });
    }

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { groupFund: true, memberShareBalances: true },
    });

    return {
      ...fund,
      memberCount: group?.memberShareBalances.length ?? 0,
    };
  }

  async joinWaitlist(groupId: string, userId: string) {
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');

    const existing = await this.prisma.waitlistEntry.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (existing) throw new BadRequestException('You are already on the waitlist for this group');

    return this.prisma.waitlistEntry.create({ data: { groupId, userId } });
  }

  async getWaitlist(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.waitlistEntry.findMany({
      where: { groupId },
      include: { user: { select: { id: true, fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async settleCycle(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        groupFund: true,
        memberShareBalances: true,
        members: { where: { isActive: true }, select: { userId: true } },
      },
    });
    if (!group) throw new NotFoundException('Group not found');

    if (
      group.groupType !== 'ACCUMULATING_SHARES' &&
      group.groupType !== 'HYBRID_ROTATING_SAVINGS' &&
      group.groupType !== 'INVESTMENT_CLUB'
    ) {
      throw new BadRequestException('Settlement is only for ASCA, Hybrid, and Investment groups');
    }

    if (!group.groupFund) throw new BadRequestException('No fund found for this group');

    // Enforce: all loans must be repaid before settlement
    const outstandingLoans = await this.prisma.loan.count({
      where: { groupId, status: 'APPROVED' },
    });
    if (outstandingLoans > 0) {
      throw new BadRequestException(
        `${outstandingLoans} outstanding loan(s) must be repaid before settlement.`,
      );
    }

    const fund = group.groupFund;
    const totalFundValue = fund.totalBalance + fund.totalInterestEarned;

    if (fund.totalShares === 0) {
      throw new BadRequestException('No shares recorded. Cannot calculate proportional payouts.');
    }

    // Calculate each member's payout
    const payouts = group.memberShareBalances.map((msb) => ({
      memberId: msb.memberId,
      shares: msb.totalShares,
      payout: Math.floor((msb.totalShares / fund.totalShares) * totalFundValue),
    }));

    await this.prisma.$transaction(async (tx) => {
      // Record settlement event
      await tx.activityFeedEvent.create({
        data: {
          groupId,
          type: 'CYCLE_SETTLED',
          data: {
            totalFundValue,
            totalShares: fund.totalShares,
            payouts,
            settledAt: new Date().toISOString(),
            settledBy: userId,
          },
        },
      });

      // Reset all member share balances
      await tx.memberShareBalance.updateMany({
        where: { groupId },
        data: { totalShares: 0, currentPeriodShares: 0, lastUpdated: new Date() },
      });

      // Reset group fund
      await tx.groupFund.update({
        where: { groupId },
        data: {
          totalBalance: 0,
          totalShares: 0,
          totalInterestEarned: 0,
          activeLoanBalance: 0,
          lastUpdated: new Date(),
        },
      });

      // Increment cycle number
      await tx.group.update({
        where: { id: groupId },
        data: { currentCycleNumber: { increment: 1 }, rotationIndex: 0 },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          actionType: 'SETTLE_CYCLE',
          targetId: groupId,
          metadata: { totalFundValue, payouts },
        },
      });
    });

    // Notify each member of their payout
    await Promise.all(
      payouts.map((p) =>
        this.notifications.sendNotification(
          p.memberId,
          NotificationType.PAYOUT_SCHEDULED,
          `Cycle settlement complete. Your payout: ${p.payout} RWF (${p.shares} shares).`,
          NotificationChannel.SMS,
        ),
      ),
    );

    return { message: 'Cycle settled successfully', payouts, totalFundValue };
  }

  async updateRotation(groupId: string, userId: string, dto: UpdateRotationDto) {
    await this.ensureTreasurer(groupId, userId);

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { rotationIndex: true, currentCycleNumber: true, members: { where: { isActive: true } } },
    });
    if (!group) throw new NotFoundException('Group not found');

    // Mid-cycle reorder requires unanimous vote — enforce via audit check
    if (group.rotationIndex > 0) {
      throw new BadRequestException(
        'Mid-cycle rotation changes require unanimous member vote. Contact admin to override.',
      );
    }

    const lastRotation = await this.prisma.rotationLog.findFirst({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
    });

    let randomSeed: string | undefined;
    let newOrder = dto.newOrder;

    if (dto.rotationType === 'RANDOM_DRAW') {
      randomSeed = randomInt(100000000, 999999999).toString();
      const arr = [...dto.newOrder];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      newOrder = arr;
    }

    return this.prisma.rotationLog.create({
      data: {
        groupId,
        actorId: userId,
        previousOrder: lastRotation?.newOrder ?? [],
        newOrder,
        randomSeed,
      },
    });
  }

  async advanceRotation(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);

    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: { members: { where: { isActive: true } } },
    });
    if (!group) throw new NotFoundException('Group not found');

    const memberCount = group.members.length;
    const newIndex = group.rotationIndex + 1;

    if (newIndex >= memberCount) {
      // Cycle complete — reset
      await this.prisma.group.update({
        where: { id: groupId },
        data: { rotationIndex: 0, currentCycleNumber: { increment: 1 } },
      });
      return { message: 'Cycle complete. Rotation reset for new cycle.', cycleNumber: group.currentCycleNumber + 1 };
    }

    await this.prisma.group.update({
      where: { id: groupId },
      data: { rotationIndex: newIndex },
    });

    return { message: 'Rotation advanced', rotationIndex: newIndex };
  }

  async deactivateMember(groupId: string, memberId: string, treasurerId: string) {
    await this.ensureTreasurer(groupId, treasurerId);

    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: memberId } },
    });

    if (!membership) throw new NotFoundException('Member not found in group');

    await this.prisma.groupMember.update({
      where: { id: membership.id },
      data: { isActive: false },
    });

    return { message: 'Member deactivated' };
  }

  async getFeed(groupId: string, userId: string) {
    await this.ensureMember(groupId, userId);
    return this.prisma.activityFeedEvent.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async postAnnouncement(groupId: string, userId: string, message: string) {
    await this.ensureTreasurer(groupId, userId);

    const event = await this.prisma.activityFeedEvent.create({
      data: { groupId, type: 'ANNOUNCEMENT', data: { message, postedBy: userId } },
    });

    // Notify all members
    const members = await this.prisma.groupMember.findMany({
      where: { groupId, isActive: true, userId: { not: userId } },
      select: { userId: true },
    });

    await Promise.all(
      members.map((m) =>
        this.notifications.sendNotification(
          m.userId,
          NotificationType.GROUP_ANNOUNCEMENT,
          `Group announcement: ${message}`,
          NotificationChannel.PUSH,
        ),
      ),
    );

    return event;
  }

  async createPenaltyRule(groupId: string, userId: string, dto: CreatePenaltyRuleDto) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.penaltyRule.create({
      data: { groupId, name: dto.name, description: dto.description, amount: dto.amount, createdById: userId },
    });
  }

  async assignPenalty(groupId: string, userId: string, dto: AssignPenaltyDto) {
    await this.ensureTreasurer(groupId, userId);
    await this.ensureMember(groupId, dto.userId);

    const rule = await this.prisma.penaltyRule.findFirst({
      where: { id: dto.penaltyRuleId, groupId, isActive: true },
    });
    if (!rule) throw new NotFoundException('Penalty rule not found in this group');

    return this.prisma.memberPenalty.create({
      data: {
        groupId,
        userId: dto.userId,
        penaltyRuleId: dto.penaltyRuleId,
        assignedById: userId,
        note: dto.note,
      },
    });
  }

  private async ensureTreasurer(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!membership || membership.role !== Role.TREASURER || !membership.isActive) {
      throw new ForbiddenException('Treasurer access required');
    }
  }

  private async ensureMember(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!membership || !membership.isActive) {
      throw new ForbiddenException('Group member access required');
    }
  }
}
