import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';

@Injectable()
export class CreditScoreService {
  constructor(private prisma: PrismaService) {}

  async calculateScore(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        contributions: { include: { group: { select: { contributionModel: true, maxSharesPerMember: true } } } },
        groupMembers: { include: { group: { select: { isSuspended: true, subscriptionStatus: true } } } },
        loansRequested: { include: { repayments: true } },
        disputesRaised: { select: { status: true } },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const activeMembers = user.groupMembers.filter((m) => m.isActive);

    if (activeMembers.length === 0) {
      return { eligible: false, message: 'Must be an active group member to receive a credit score' };
    }

    const firstJoin = activeMembers.reduce(
      (earliest, m) => (m.joinedAt < earliest ? m.joinedAt : earliest),
      activeMembers[0].joinedAt,
    );

    const tenureMonths = (Date.now() - firstJoin.getTime()) / (1000 * 60 * 60 * 24 * 30);

    if (tenureMonths < 3) {
      return {
        eligible: false,
        message: 'Must be active for at least 3 months to receive a credit score',
        eligibleDate: new Date(firstJoin.getTime() + 90 * 24 * 60 * 60 * 1000),
      };
    }

    const breakdown: Record<string, number> = {};

    // ── 1. Payment Consistency (35% = 350 pts) ──────────────────────────────
    const total = user.contributions.length;
    let weightedSum = 0;
    for (const c of user.contributions) {
      if (c.status === 'VERIFIED') weightedSum += 1.0;
      else if (c.status === 'LATE') weightedSum += 0.7;
      // MISSED = 0
    }
    breakdown.paymentConsistency = total > 0 ? Math.round((weightedSum / total) * 350) : 0;

    // ── 2. Tenure Length (25% = 212 pts max) ────────────────────────────────
    let tenureScore = 0;
    if (tenureMonths >= 24) tenureScore = 212;
    else if (tenureMonths >= 12) tenureScore = 150 + Math.round(((tenureMonths - 12) / 12) * 62);
    else if (tenureMonths >= 6) tenureScore = 100 + Math.round(((tenureMonths - 6) / 6) * 50);
    else tenureScore = Math.round((tenureMonths / 6) * 100);

    // +10 per additional active group beyond first, max +30
    const multiGroupBonus = Math.min(30, (activeMembers.length - 1) * 10);
    breakdown.tenure = Math.min(212, tenureScore + multiGroupBonus);

    // ── 3. Contribution Reliability (15% = 127 pts) ──────────────────────────
    const flexContribs = user.contributions.filter(
      (c) => c.group.contributionModel === 'FLEXIBLE_SHARES' && c.sharesCount != null,
    );
    const fixedContribs = user.contributions.filter(
      (c) => c.group.contributionModel !== 'FLEXIBLE_SHARES',
    );

    let reliabilityScore = 0;

    if (flexContribs.length > 0) {
      // Average ratio of shares purchased vs max available
      const ratioSum = flexContribs.reduce((sum, c) => {
        const max = c.group.maxSharesPerMember ?? 1;
        return sum + (c.sharesCount! / max);
      }, 0);
      const avgRatio = ratioSum / flexContribs.length;
      reliabilityScore = Math.round(avgRatio * 127);
      // Cap at 60 if member always buys minimum (ratio <= 1/max consistently)
      const alwaysMin = flexContribs.every((c) => c.sharesCount === 1);
      if (alwaysMin) reliabilityScore = Math.min(60, reliabilityScore);
    } else if (fixedContribs.length > 0) {
      const paid = fixedContribs.filter((c) => c.status === 'VERIFIED' || c.status === 'LATE').length;
      reliabilityScore = Math.round((paid / fixedContribs.length) * 127);
    }

    breakdown.contributionReliability = Math.min(127, reliabilityScore);

    // ── 4. Loan Repayment History (20% = 170 pts) ────────────────────────────
    const loans = user.loansRequested.filter((l) => l.status !== 'PENDING' && l.status !== 'DECLINED');

    if (loans.length === 0) {
      breakdown.loanRepayment = 0; // neutral — no penalty, no bonus
    } else {
      let loanScore = 0;
      for (const loan of loans) {
        const totalRepaid = loan.repayments.reduce((s, r) => s + r.amount, 0);
        const due = loan.totalRepayable || loan.amount;
        const repaidOnTime = loan.status === 'REPAID' && totalRepaid >= due;

        if (loan.status === 'DEFAULTED') {
          loanScore -= 200;
        } else if (repaidOnTime) {
          // Weight by loan size relative to contributions
          loanScore += 170;
        } else if (loan.status === 'REPAID') {
          loanScore += 50; // repaid late
        }
      }
      breakdown.loanRepayment = Math.max(-200, Math.min(170, loanScore));
    }

    // ── 5. Group Health Bonus (5% = 42 pts max) ──────────────────────────────
    let healthBonus = 0;

    const hasActiveSub = activeMembers.some(
      (m) => m.group.subscriptionStatus === 'ACTIVE' || m.group.subscriptionStatus === 'TRIAL',
    );
    if (hasActiveSub) healthBonus += 25;

    // Zero disputes in last 6 months across member's groups
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const recentDisputes = await this.prisma.dispute.count({
      where: {
        groupId: { in: activeMembers.map((m) => m.groupId) },
        createdAt: { gte: sixMonthsAgo },
      },
    });
    if (recentDisputes === 0) healthBonus += 15;

    const disputesAgainstMember = user.disputesRaised.filter(
      (d) => d.status === 'OPEN' || d.status === 'ESCALATED',
    ).length;
    if (disputesAgainstMember === 0) healthBonus += 10;

    // Treasurer with zero disputes
    const isTreasurer = activeMembers.some((m) => m.role === 'TREASURER');
    if (isTreasurer && disputesAgainstMember === 0) healthBonus += 10;

    breakdown.groupHealthBonus = Math.min(42, healthBonus);

    // ── Final score ──────────────────────────────────────────────────────────
    let score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    score = Math.max(0, Math.min(850, score));

    let label: string;
    if (score >= 750) label = 'EXCELLENT';
    else if (score >= 550) label = 'GOOD';
    else if (score >= 300) label = 'FAIR';
    else label = 'BUILDING';

    const currentScore = await this.prisma.creditScore.upsert({
      where: { userId },
      update: { score, label, breakdown, lastUpdated: new Date() },
      create: { userId, score, label, breakdown },
    });

    await this.prisma.creditScoreHistory.create({
      data: { userId, score, label, breakdown },
    });

    return { eligible: true, ...currentScore };
  }

  async getMyScore(userId: string) {
    const score = await this.prisma.creditScore.findUnique({ where: { userId } });
    if (!score) return this.calculateScore(userId);
    return { eligible: true, ...score };
  }

  async getMyHistory(userId: string) {
    return this.prisma.creditScoreHistory.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
    });
  }

  async getMyReport(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        contributions: { orderBy: { createdAt: 'desc' }, take: 10 },
        loansRequested: { orderBy: { createdAt: 'desc' } },
        groupMembers: {
          where: { isActive: true },
          include: { group: { select: { name: true, frequency: true, groupType: true } } },
        },
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const score = await this.getMyScore(userId);

    const totalSaved = await this.prisma.contribution.aggregate({
      where: { userId, status: { in: ['VERIFIED', 'LATE'] } },
      _sum: { amount: true },
    });

    const loanStats = await this.prisma.loan.groupBy({
      by: ['status'],
      where: { requesterId: userId },
      _count: { _all: true },
    });

    const paymentConsistencyRate =
      user.contributions.length > 0
        ? (
            (user.contributions.filter((c) => c.status === 'VERIFIED').length /
              user.contributions.length) *
            100
          ).toFixed(1)
        : '0.0';

    return {
      currentScore: (score as any).score ?? 0,
      scoreCategory: (score as any).label ?? 'BUILDING',
      totalMonthsActive: Math.floor(
        (Date.now() - (user.groupMembers[0]?.joinedAt?.getTime() ?? Date.now())) /
          (1000 * 60 * 60 * 24 * 30),
      ),
      totalGroupsParticipated: user.groupMembers.length,
      paymentConsistencyRate: `${paymentConsistencyRate}%`,
      totalAmountSaved: totalSaved._sum.amount ?? 0,
      loansRequested: loanStats.reduce((s, l) => s + l._count._all, 0),
      loansRepaidOnTime: loanStats.find((l) => l.status === 'REPAID')?._count._all ?? 0,
      loansDefaulted: loanStats.find((l) => l.status === 'DEFAULTED')?._count._all ?? 0,
      currentActiveGroups: user.groupMembers.map((m) => ({
        name: m.group.name,
        type: m.group.groupType,
        monthsActive: Math.floor(
          (Date.now() - m.joinedAt.getTime()) / (1000 * 60 * 60 * 24 * 30),
        ),
      })),
      lastUpdated: (score as any).lastUpdated,
      reportGeneratedAt: new Date(),
    };
  }

  async shareReport(userId: string) {
    const activeMembership = await this.prisma.groupMember.findFirst({
      where: { userId, isActive: true, group: { isSuspended: false } },
    });
    if (!activeMembership) {
      throw new ForbiddenException('You must be in an active group to share your credit report.');
    }

    // Enforce max 3 active links at a time
    const activeLinks = await this.prisma.sharedCreditReport.count({
      where: { userId, revoked: false, expiresAt: { gt: new Date() } },
    });
    if (activeLinks >= 3) {
      throw new BadRequestException(
        'You already have 3 active report links. Revoke an existing link before generating a new one.',
      );
    }

    const linkId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const share = await this.prisma.sharedCreditReport.create({
      data: { userId, linkId, expiresAt },
    });

    const baseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5000';
    return {
      shareUrl: `${baseUrl}/credit-score/report/shared/${share.linkId}`,
      expiresAt,
      activeLinksCount: activeLinks + 1,
    };
  }

  async revokeShare(linkId: string, userId: string) {
    const share = await this.prisma.sharedCreditReport.findUnique({ where: { linkId } });
    if (!share || share.userId !== userId) throw new NotFoundException('Shared link not found');

    await this.prisma.sharedCreditReport.update({
      where: { linkId },
      data: { revoked: true },
    });
    return { message: 'Link revoked successfully' };
  }

  async getSharedReport(token: string, ipAddress: string) {
    const share = await this.prisma.sharedCreditReport.findUnique({ where: { linkId: token } });

    if (!share || share.revoked) throw new NotFoundException('Link is invalid or revoked');
    if (share.expiresAt < new Date()) throw new ForbiddenException('Link has expired');

    await this.prisma.sharedReportAccessLog.create({
      data: { sharedReportId: share.id, ipAddress },
    });

    return this.getMyReport(share.userId);
  }

  // Every Sunday midnight — full recalculation for all active members
  @Cron('0 0 * * 0')
  async weeklyRecalculation() {
    const activeMembers = await this.prisma.groupMember.findMany({
      where: { isActive: true },
      select: { userId: true },
      distinct: ['userId'],
    });

    for (const m of activeMembers) {
      try {
        await this.calculateScore(m.userId);
      } catch {
        // continue on individual failure
      }
    }
  }
}
