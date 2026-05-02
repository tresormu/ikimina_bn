import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'crypto';

@Injectable()
export class CreditScoreService {
  constructor(private prisma: PrismaService) {}

  async calculateScore(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        contributions: true,
        groupMembers: true,
        loansRequested: true,
      }
    });

    if (!user) throw new NotFoundException('User not found');

    // Tenure check
    const firstJoin = user.groupMembers.reduce((earliest, member) => 
      member.joinedAt < earliest ? member.joinedAt : earliest, new Date());
    
    const tenureMonths = (Date.now() - firstJoin.getTime()) / (1000 * 60 * 60 * 24 * 30);
    
    if (tenureMonths < 3) {
      return {
        eligible: false,
        message: 'Must be active for at least 3 months to receive a credit score',
        eligibleDate: new Date(firstJoin.getTime() + 90 * 24 * 60 * 60 * 1000)
      };
    }

    let score = 0;
    const breakdown = {
      onTimePayment: 0,
      tenure: 0,
      missedPayments: 0,
      loanRepayment: 0,
      groupSizeBonus: 0,
    };

    // 1. On-time payment (Max 400)
    const confirmed = user.contributions.filter(c => c.status === 'CONFIRMED').length;
    const total = user.contributions.length;
    const onTimePct = total > 0 ? (confirmed / total) : 0;
    breakdown.onTimePayment = Math.round(onTimePct * 400);

    // 2. Tenure (Max 200)
    breakdown.tenure = Math.min(200, Math.round(tenureMonths * 10));

    // 3. Missed payments (Deduct 50 each)
    const missed = user.contributions.filter(c => c.status === 'MISSED').length;
    breakdown.missedPayments = -(missed * 50);

    // 4. Loan Repayment (Max 150)
    const repaidLoans = user.loansRequested.filter(l => l.status === 'REPAID').length;
    breakdown.loanRepayment = Math.min(150, repaidLoans * 50);

    // 5. Group Size Bonus (Max 100)
    breakdown.groupSizeBonus = Math.min(100, user.groupMembers.length * 20);

    score = Object.values(breakdown).reduce((a, b) => a + b, 0);
    score = Math.max(0, Math.min(850, score)); // clamp 0-850

    let label = 'Poor';
    if (score >= 750) label = 'Excellent';
    else if (score >= 550) label = 'Good';
    else if (score >= 300) label = 'Fair';

    // Upsert
    const currentScore = await this.prisma.creditScore.upsert({
      where: { userId },
      update: { score, label, breakdown, lastUpdated: new Date() },
      create: { userId, score, label, breakdown },
    });

    await this.prisma.creditScoreHistory.create({
      data: { userId, score, label, breakdown }
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
      orderBy: { timestamp: 'desc' }
    });
  }

  async getMyReport(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        contributions: { orderBy: { createdAt: 'desc' }, take: 10 },
        loansRequested: { orderBy: { createdAt: 'desc' } },
        groupMembers: { include: { group: { select: { name: true, frequency: true } } } },
      }
    });

    const score = await this.getMyScore(userId);

    if (!user) throw new NotFoundException('User not found');

    return {
      profile: { name: user.fullName, phone: user.phoneNumber },
      score,
      contributions: user.contributions,
      loans: user.loansRequested,
      groups: user.groupMembers,
    };
  }

  async shareReport(userId: string) {
    // Check user is in at least one active (non-suspended) group
    const activeMembership = await this.prisma.groupMember.findFirst({
      where: {
        userId,
        isActive: true,
        group: { isSuspended: false },
      },
    });
    if (!activeMembership) {
      throw new ForbiddenException('You must be in an active group to share your credit report.');
    }

    const linkId = randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const share = await this.prisma.sharedCreditReport.create({
      data: { userId, linkId, expiresAt }
    });

    return { shareUrl: `/credit-score/report/shared/${share.linkId}`, expiresAt };
  }

  async revokeShare(linkId: string, userId: string) {
    const share = await this.prisma.sharedCreditReport.findUnique({ where: { linkId } });
    if (!share || share.userId !== userId) throw new NotFoundException('Shared link not found');

    await this.prisma.sharedCreditReport.update({
      where: { linkId },
      data: { revoked: true }
    });
    return { message: 'Link revoked successfully' };
  }

  async getSharedReport(token: string, ipAddress: string) {
    const share = await this.prisma.sharedCreditReport.findUnique({ where: { linkId: token } });
    
    if (!share || share.revoked) throw new NotFoundException('Link is invalid or revoked');
    if (share.expiresAt < new Date()) throw new ForbiddenException('Link has expired');

    // Log access
    await this.prisma.sharedReportAccessLog.create({
      data: { sharedReportId: share.id, ipAddress }
    });

    return this.getMyReport(share.userId);
  }
}
