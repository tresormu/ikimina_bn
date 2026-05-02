import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestLoanDto } from './dto/request-loan.dto';
import { VoteLoanDto } from './dto/vote-loan.dto';
import { RepayLoanDto } from './dto/repay-loan.dto';
import { LoanStatus, Role } from '@prisma/client';

@Injectable()
export class LoansService {
  private readonly logger = new Logger(LoansService.name);

  constructor(private prisma: PrismaService) {}

  async requestLoan(userId: string, dto: RequestLoanDto) {
    const group = await this.prisma.group.findUnique({ where: { id: dto.groupId } });
    if (!group) throw new NotFoundException('Group not found');
    if (group.isSuspended) throw new BadRequestException('Group is suspended. Loan requests are not accepted.');

    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: dto.groupId, userId } }
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException('You must be an active member of this group to request a loan');
    }

    // Check tenure (must be >= 6 months)
    const tenureMonths = (Date.now() - membership.joinedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (tenureMonths < 6) {
      throw new BadRequestException('You must be a member for at least 6 months to request a loan');
    }

    return this.prisma.loan.create({
      data: {
        groupId: dto.groupId,
        requesterId: userId,
        amount: dto.amount,
        reason: dto.reason,
        status: LoanStatus.PENDING,
      }
    });
  }

  async getMyLoans(userId: string) {
    return this.prisma.loan.findMany({
      where: { requesterId: userId },
      orderBy: { createdAt: 'desc' },
      include: { group: { select: { name: true } } }
    });
  }

  async getGroupLoans(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.loan.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      include: { requester: { select: { fullName: true, phoneNumber: true } } }
    });
  }

  async getPendingVotes(userId: string) {
    // Find groups the user is in
    const memberships = await this.prisma.groupMember.findMany({
      where: { userId, isActive: true },
      select: { groupId: true }
    });

    const groupIds = memberships.map(m => m.groupId);

    // Find pending loans in those groups where the user hasn't voted yet
    return this.prisma.loan.findMany({
      where: {
        groupId: { in: groupIds },
        status: LoanStatus.PENDING,
        votes: {
          none: { voterId: userId }
        }
      },
      include: { 
        requester: { select: { fullName: true } },
        group: { select: { name: true } } 
      }
    });
  }

  async vote(loanId: string, userId: string, dto: VoteLoanDto) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new NotFoundException('Loan not found');
    if (loan.status !== LoanStatus.PENDING) throw new BadRequestException('Loan is no longer pending');

    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: loan.groupId, userId } }
    });

    if (!membership || !membership.isActive) throw new ForbiddenException('Not an active member of the group');

    // Create vote
    await this.prisma.loanVote.create({
      data: { loanId, voterId: userId, vote: dto.vote }
    });

    // Check if majority reached
    const totalActiveMembers = await this.prisma.groupMember.count({
      where: { groupId: loan.groupId, isActive: true }
    });

    const approvals = await this.prisma.loanVote.count({
      where: { loanId, vote: 'APPROVE' }
    });

    const rejections = await this.prisma.loanVote.count({
      where: { loanId, vote: 'DECLINE' }
    });

    const majority = Math.floor(totalActiveMembers / 2) + 1;

    let updatedLoan = loan;

    if (approvals >= majority) {
      updatedLoan = await this.prisma.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.APPROVED, disbursedAt: new Date() }
      });
      // Mock Disbursement
      const requester = await this.prisma.user.findUnique({ where: { id: loan.requesterId } });
      this.logger.log(`[MOCK MOMO] Disbursing ${loan.amount} to ${requester?.phoneNumber}`);
      // TODO: Notify Requester and Treasurer
    } else if (rejections >= majority) {
      updatedLoan = await this.prisma.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.DECLINED }
      });
      // TODO: Notify Requester
    }

    return { message: 'Vote recorded', loan: updatedLoan };
  }

  async repay(loanId: string, treasurerId: string, dto: RepayLoanDto) {
    const loan = await this.prisma.loan.findUnique({ where: { id: loanId } });
    if (!loan) throw new NotFoundException('Loan not found');
    
    await this.ensureTreasurer(loan.groupId, treasurerId);

    if (loan.status !== LoanStatus.APPROVED) {
      throw new BadRequestException('Only approved loans can be repaid');
    }

    const repayment = await this.prisma.loanRepayment.create({
      data: { loanId, amount: dto.amount }
    });

    // Check if fully repaid
    const allRepayments = await this.prisma.loanRepayment.findMany({ where: { loanId } });
    const totalRepaid = allRepayments.reduce((sum, r) => sum + r.amount, 0);

    if (totalRepaid >= loan.amount) {
      await this.prisma.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.REPAID }
      });
      // Trigger credit score recalculation
    }

    return repayment;
  }

  private async ensureTreasurer(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    if (!membership || membership.role !== Role.TREASURER || !membership.isActive) {
      throw new ForbiddenException('Treasurer access required');
    }
  }
}
