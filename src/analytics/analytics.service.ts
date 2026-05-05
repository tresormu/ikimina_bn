import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async getGroupAnalytics(groupId: string, userId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: { where: { isActive: true } },
        contributions: true,
        loans: { include: { repayments: true } },
        groupFund: true,
      },
    });

    if (!group) throw new NotFoundException('Group not found');
    if (!group.members.find((m) => m.userId === userId)) throw new ForbiddenException('Not a member');

    const totalContributions = group.contributions.reduce((acc, c) => acc + (c.amount || 0), 0);
    const activeLoans = group.loans.filter((l) => l.status === 'APPROVED');
    const totalActiveLoanAmount = activeLoans.reduce((acc, l) => acc + l.amount, 0);

    const verifiedCount = group.contributions.filter((c) => c.status === 'VERIFIED').length;
    const missedCount = group.contributions.filter((c) => c.status === 'MISSED').length;
    const paymentRate =
      group.contributions.length > 0
        ? ((verifiedCount / group.contributions.length) * 100).toFixed(1)
        : '0.0';

    return {
      groupId,
      totalContributions,
      totalActiveLoanAmount,
      fundBalance: group.groupFund?.totalBalance ?? 0,
      fundTotalShares: group.groupFund?.totalShares ?? 0,
      totalInterestEarned: group.groupFund?.totalInterestEarned ?? 0,
      activeMembersCount: group.members.length,
      verifiedContributions: verifiedCount,
      missedContributions: missedCount,
      paymentRate: `${paymentRate}%`,
      activeLoansCount: activeLoans.length,
    };
  }

  async getMemberAnalytics(memberId: string, requestingUserId: string) {
    // Requester must be the member themselves or a treasurer of a shared group
    const sharedGroup = await this.prisma.groupMember.findFirst({
      where: {
        userId: requestingUserId,
        isActive: true,
        role: Role.TREASURER,
        group: { members: { some: { userId: memberId, isActive: true } } },
      },
    });

    const isSelf = memberId === requestingUserId;
    if (!isSelf && !sharedGroup) {
      throw new ForbiddenException('Access denied');
    }

    const contributions = await this.prisma.contribution.findMany({
      where: { userId: memberId },
      include: { group: { select: { name: true } } },
    });

    const loans = await this.prisma.loan.findMany({
      where: { requesterId: memberId },
      include: { repayments: true },
    });

    const totalContributed = contributions
      .filter((c) => c.status === 'VERIFIED' || c.status === 'LATE')
      .reduce((acc, c) => acc + (c.amount || 0), 0);

    const onTimeRate =
      contributions.length > 0
        ? ((contributions.filter((c) => c.status === 'VERIFIED').length / contributions.length) * 100).toFixed(1)
        : '0.0';

    return {
      memberId,
      totalContributed,
      contributionsCount: contributions.length,
      onTimePaymentRate: `${onTimeRate}%`,
      missedCount: contributions.filter((c) => c.status === 'MISSED').length,
      lateCount: contributions.filter((c) => c.status === 'LATE').length,
      loansRequested: loans.length,
      loansRepaid: loans.filter((l) => l.status === 'REPAID').length,
      loansDefaulted: loans.filter((l) => l.status === 'DEFAULTED').length,
    };
  }

  async getPlatformAnalytics(userId: string) {
    // Admin only
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { roles: true } });
    if (!user?.roles.includes(Role.ADMIN)) throw new ForbiddenException('Admin access required');

    const [totalGroups, totalUsers, totalContributions, activeGroups, suspendedGroups] =
      await Promise.all([
        this.prisma.group.count(),
        this.prisma.user.count({ where: { isActive: true } }),
        this.prisma.contribution.aggregate({ _sum: { amount: true } }),
        this.prisma.group.count({ where: { isSuspended: false } }),
        this.prisma.group.count({ where: { isSuspended: true } }),
      ]);

    return {
      totalGroups,
      activeGroups,
      suspendedGroups,
      totalUsers,
      totalContributionsAmount: totalContributions._sum.amount ?? 0,
    };
  }
}
