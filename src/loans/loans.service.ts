import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestLoanDto } from './dto/request-loan.dto';
import { RepayLoanDto } from './dto/repay-loan.dto';
import { LoanStatus, Role, NotificationType, NotificationChannel } from '@prisma/client';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async requestLoan(userId: string, dto: RequestLoanDto) {
    const group = await this.prisma.group.findUnique({
      where: { id: dto.groupId },
      include: { groupFund: true },
    });
    if (!group) throw new NotFoundException('Group not found');
    if (group.isSuspended) throw new BadRequestException('Group is suspended.');
    if (!group.loansEnabled) throw new BadRequestException('Loans are not enabled for this group.');

    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: dto.groupId, userId } },
    });
    if (!membership || !membership.isActive) {
      throw new ForbiddenException('You must be an active member to request a loan');
    }

    // 1. Tenure check — use group config
    const tenureMonths = (Date.now() - membership.joinedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (tenureMonths < group.loanMinTenureMonths) {
      const msg = `You must be a member for at least ${group.loanMinTenureMonths} months to request a loan`;
      await this.notifications.sendNotification(userId, NotificationType.LOAN_DECLINED, msg, NotificationChannel.SMS);
      throw new BadRequestException(msg);
    }

    // 2. Zero missed contributions in last 3 periods
    const latestContribs = await this.prisma.contribution.findMany({
      where: { groupId: dto.groupId, userId },
      orderBy: { weekNumber: 'desc' },
      take: 3,
    });
    const missedRecent = latestContribs.filter((c) => c.status === 'MISSED').length;
    if (missedRecent > 0) {
      const msg = 'You have missed contributions in the last 3 periods. Loan not eligible.';
      await this.notifications.sendNotification(userId, NotificationType.LOAN_DECLINED, msg, NotificationChannel.SMS);
      throw new BadRequestException(msg);
    }

    // 3. No existing unpaid loan from this group
    const existingLoan = await this.prisma.loan.findFirst({
      where: { groupId: dto.groupId, requesterId: userId, status: LoanStatus.APPROVED },
    });
    if (existingLoan) {
      const msg = 'You already have an outstanding loan in this group.';
      await this.notifications.sendNotification(userId, NotificationType.LOAN_DECLINED, msg, NotificationChannel.SMS);
      throw new BadRequestException(msg);
    }

    // 4. Loan amount vs fund percentage cap
    if (group.groupFund) {
      const maxLoanAmount = Math.floor((group.loanMaxPercentage / 100) * group.groupFund.totalBalance);
      if (dto.amount > maxLoanAmount) {
        const msg = `Loan amount exceeds the maximum allowed (${group.loanMaxPercentage}% of fund = ${maxLoanAmount} RWF)`;
        await this.notifications.sendNotification(userId, NotificationType.LOAN_DECLINED, msg, NotificationChannel.SMS);
        throw new BadRequestException(msg);
      }
    }

    // 5. ASCA groups: minimum 10% share ownership for loans above 10% of fund
    if (group.groupType === 'ACCUMULATING_SHARES' && group.groupFund) {
      const shareBalance = await this.prisma.memberShareBalance.findUnique({
        where: { groupId_memberId: { groupId: dto.groupId, memberId: userId } },
      });
      const ownershipRatio =
        group.groupFund.totalShares > 0 && shareBalance
          ? shareBalance.totalShares / group.groupFund.totalShares
          : 0;
      const largeThreshold = Math.floor(group.groupFund.totalBalance * 0.1);
      if (dto.amount > largeThreshold && ownershipRatio < 0.1) {
        const msg = 'You must own at least 10% of group shares to request a large loan.';
        await this.notifications.sendNotification(userId, NotificationType.LOAN_DECLINED, msg, NotificationChannel.SMS);
        throw new BadRequestException(msg);
      }
    }

    // 6. Calculate interest and total repayable
    const interestRate = group.loanInterestRate ? Number(group.loanInterestRate) : 0;
    const repaymentMonths = dto.repaymentMonths ?? 1;
    const interestAmount = Math.floor(dto.amount * (interestRate / 100) * repaymentMonths);
    const totalRepayable = dto.amount + interestAmount;

    const loan = await this.prisma.loan.create({
      data: {
        groupId: dto.groupId,
        requesterId: userId,
        amount: dto.amount,
        interestAmount,
        totalRepayable,
        repaymentMonths,
        reason: dto.reason,
        status: LoanStatus.PENDING,
      },
    });

    // Notify treasurer only — loan request is private between member and treasurer
    const treasurer = await this.prisma.groupMember.findFirst({
      where: { groupId: dto.groupId, role: Role.TREASURER, isActive: true },
    });
    if (treasurer) {
      const requester = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true },
      });
      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.LOAN_APPROVED,
        `${requester?.fullName ?? 'A member'} requested a loan of ${dto.amount} RWF. Review in your dashboard.`,
        NotificationChannel.SMS,
      );
      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.LOAN_APPROVED,
        `${requester?.fullName ?? 'A member'} requested a loan of ${dto.amount} RWF. Review in your dashboard.`,
        NotificationChannel.PUSH,
      );
    }

    return loan;
  }

  async decideLoan(loanId: string, userId: string, decision: 'APPROVED' | 'DECLINED', note?: string) {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: { group: { include: { groupFund: true } } },
    });
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status !== LoanStatus.PENDING) throw new BadRequestException('Loan is no longer pending');

    await this.ensureTreasurer(loan.groupId, userId);

    if (decision === 'APPROVED') {
      await this.prisma.$transaction(async (tx) => {
        await tx.loan.update({
          where: { id: loanId },
          data: {
            status: LoanStatus.APPROVED,
            disbursedAt: new Date(),
            decidedById: userId,
            decisionNote: note ?? null,
          },
        });

        // Deduct from GroupFund for ASCA/Hybrid groups
        if (loan.group.groupFund) {
          await tx.groupFund.update({
            where: { groupId: loan.groupId },
            data: {
              totalBalance: { decrement: loan.amount },
              activeLoanBalance: { increment: loan.amount },
              lastUpdated: new Date(),
            },
          });
        }
      });

      await this.notifications.sendNotification(
        loan.requesterId,
        NotificationType.LOAN_APPROVED,
        `Your loan of ${loan.amount} RWF has been approved. Total repayable: ${loan.totalRepayable} RWF over ${loan.repaymentMonths} month(s). The treasurer will disburse via MoMo.`,
        NotificationChannel.SMS,
      );
    } else {
      await this.prisma.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.DECLINED, decidedById: userId, decisionNote: note ?? null },
      });

      await this.notifications.sendNotification(
        loan.requesterId,
        NotificationType.LOAN_DECLINED,
        `Your loan request of ${loan.amount} RWF was declined.${note ? ` Reason: ${note}` : ''}`,
        NotificationChannel.SMS,
      );
    }

    return { message: `Loan ${decision.toLowerCase()}` };
  }

  async getMyLoans(userId: string) {
    return this.prisma.loan.findMany({
      where: { requesterId: userId },
      orderBy: { createdAt: 'desc' },
      include: { group: { select: { name: true } }, repayments: true },
    });
  }

  async getGroupLoans(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.loan.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      include: {
        requester: { select: { fullName: true, phoneNumber: true } },
        repayments: true,
      },
    });
  }

  async repay(loanId: string, treasurerId: string, dto: RepayLoanDto) {
    const loan = await this.prisma.loan.findUnique({
      where: { id: loanId },
      include: { group: { include: { groupFund: true } } },
    });
    if (!loan) throw new NotFoundException('Loan not found');

    await this.ensureTreasurer(loan.groupId, treasurerId);

    if (loan.status !== LoanStatus.APPROVED) {
      throw new BadRequestException('Only approved loans can be repaid');
    }

    const repayment = await this.prisma.loanRepayment.create({
      data: { loanId, amount: dto.amount },
    });

    const aggregate = await this.prisma.loanRepayment.aggregate({
      where: { loanId },
      _sum: { amount: true },
    });
    const totalRepaid = aggregate._sum.amount ?? 0;
    const due = loan.totalRepayable || loan.amount;

    if (totalRepaid >= due) {
      await this.prisma.$transaction(async (tx) => {
        await tx.loan.update({ where: { id: loanId }, data: { status: LoanStatus.REPAID } });

        // Return principal + interest to GroupFund
        if (loan.group.groupFund) {
          await tx.groupFund.update({
            where: { groupId: loan.groupId },
            data: {
              totalBalance: { increment: loan.totalRepayable },
              activeLoanBalance: { decrement: loan.amount },
              totalInterestEarned: { increment: loan.interestAmount },
              lastUpdated: new Date(),
            },
          });
        }
      });
    }

    return repayment;
  }

  // Daily — flag loans overdue by 30+ days as DEFAULTED
  // Uses cursor-based pagination to avoid OOM
  @Cron('0 7 * * *')
  async checkLoanDefaults() {
    const overdueThreshold = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let cursor: string | undefined;

    while (true) {
      const approvedLoans = await this.prisma.loan.findMany({
        where: { status: LoanStatus.APPROVED, disbursedAt: { lt: overdueThreshold } },
        include: { repayments: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (approvedLoans.length === 0) break;

      for (const loan of approvedLoans) {
        const totalRepaid = loan.repayments.reduce((s, r) => s + r.amount, 0);
        if (totalRepaid < loan.totalRepayable) {
          await this.prisma.loan.update({
            where: { id: loan.id },
            data: { status: LoanStatus.DEFAULTED },
          });

          await this.notifications.sendNotification(
            loan.requesterId,
            NotificationType.LOAN_DEFAULT,
            `Your loan of ${loan.amount} RWF has been marked as defaulted. This will significantly impact your credit score.`,
            NotificationChannel.SMS,
          );
        }
      }

      cursor = approvedLoans[approvedLoans.length - 1].id;
      if (approvedLoans.length < 500) break;
    }
  }

  private async ensureTreasurer(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } },
    });
    if (!membership || membership.role !== Role.TREASURER || !membership.isActive) {
      throw new ForbiddenException('Treasurer access required');
    }
  }
}
