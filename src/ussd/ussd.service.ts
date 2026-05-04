import { Injectable } from '@nestjs/common';
import { GroupFrequency, LoanStatus, MemberPenaltyStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UssdRequestDto } from './dto/ussd-request.dto';

type MemberGroup = {
  id: string;
  name: string;
  contributionAmount: number;
  frequency: GroupFrequency;
  createdAt: Date;
  bankName: string | null;
  bankAccountNumber: string | null;
};

@Injectable()
export class UssdService {
  constructor(private prisma: PrismaService) {}

  async handleUssd(dto: UssdRequestDto) {
    const { sessionId, phoneNumber, text } = dto;
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (!user) {
      return 'END Welcome to IkiminaPass. Register first using your group invite process.';
    }

    const memberships = await this.prisma.groupMember.findMany({
      where: { userId: user.id, isActive: true },
      include: { group: true },
      orderBy: { joinedAt: 'asc' },
    });

    if (memberships.length === 0) {
      return 'END You are not an active member of any group. Contact your treasurer.';
    }

    const groups: MemberGroup[] = memberships.map((m) => ({
      id: m.group.id,
      name: m.group.name,
      contributionAmount: m.group.contributionAmount,
      frequency: m.group.frequency,
      createdAt: m.group.createdAt,
      bankName: m.group.bankName,
      bankAccountNumber: m.group.bankAccountNumber,
    }));

    const parts = text ? text.split('*').filter(Boolean) : [];

    let response: string;
    if (parts.length === 0) {
      response = this.mainMenu();
    } else if (parts[0] === '1') {
      response = await this.handleContributions(parts, user.id, groups);
    } else if (parts[0] === '2') {
      response = await this.handlePenalties(parts, user.id, groups);
    } else if (parts[0] === '3') {
      response = await this.handleLoans(parts, user.id, groups);
    } else if (parts[0] === '4') {
      response = this.handleGroupDirectory(parts, groups);
    } else {
      response = 'END Invalid option.';
    }

    await this.persistSession(sessionId, user.id, text);
    return response;
  }

  private mainMenu() {
    return 'CON IkiminaPass\n1. Contributions\n2. Penalties\n3. Loans\n4. My groups';
  }

  private async handleContributions(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Contributions\n1. Pay contribution\n2. Recent submissions';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) {
        return `CON Select group\n${this.groupOptions(groups)}`;
      }

      const group = this.pickGroup(parts[2], groups);
      if (!group) return 'END Invalid group selection.';

      if (parts.length === 3) {
        return `CON Pay ${group.contributionAmount} RWF to ${group.bankName ?? 'group bank'} (${group.bankAccountNumber ?? 'account not set'}).\nEnter bank reference:`;
      }

      const bankReference = parts[3]?.trim();
      if (!this.isReferenceValid(bankReference)) {
        return 'END Invalid bank reference. Use 4-40 letters/numbers.';
      }

      const weekNumber = this.calculateCurrentCycleWeek(group.createdAt, group.frequency);
      const existing = await this.prisma.contribution.findFirst({
        where: {
          groupId: group.id,
          userId,
          weekNumber,
          bankReference,
        },
        select: { id: true },
      });
      if (existing) {
        return 'END This contribution reference was already submitted.';
      }

      await this.prisma.contribution.create({
        data: {
          groupId: group.id,
          userId,
          amount: group.contributionAmount,
          weekNumber,
          bankReference,
          status: 'PENDING',
        },
      });
      return 'END Contribution submitted as pending verification.';
    }

    if (parts[1] === '2') {
      const recent = await this.prisma.contribution.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 3,
        include: { group: { select: { name: true } } },
      });

      if (recent.length === 0) return 'END No contributions submitted yet.';

      const rows = recent
        .map((c, i) => `${i + 1}. ${c.group.name}: ${c.amount} (${c.status})`)
        .join('\n');
      return `END Recent contributions\n${rows}`;
    }

    return 'END Invalid contribution option.';
  }

  private async handlePenalties(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Penalties\n1. View pending\n2. Pay penalty';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) {
        return `CON Select group\n${this.groupOptions(groups)}`;
      }
      const group = this.pickGroup(parts[2], groups);
      if (!group) return 'END Invalid group selection.';

      const pending = await this.prisma.memberPenalty.findMany({
        where: { userId, groupId: group.id, status: MemberPenaltyStatus.PENDING },
        include: { penaltyRule: true },
        orderBy: { createdAt: 'asc' },
        take: 9,
      });

      if (pending.length === 0) return 'END You have no pending penalties in this group.';
      const list = pending.map((p, i) => `${i + 1}. ${p.penaltyRule.name} - ${p.penaltyRule.amount} RWF`).join('\n');
      return `END Pending penalties\n${list}`;
    }

    if (parts[1] === '2') {
      if (parts.length === 2) {
        return `CON Select group\n${this.groupOptions(groups)}`;
      }
      const group = this.pickGroup(parts[2], groups);
      if (!group) return 'END Invalid group selection.';

      const pending = await this.prisma.memberPenalty.findMany({
        where: { userId, groupId: group.id, status: MemberPenaltyStatus.PENDING },
        include: { penaltyRule: true },
        orderBy: { createdAt: 'asc' },
        take: 9,
      });
      if (pending.length === 0) return 'END You have no pending penalties in this group.';

      if (parts.length === 3) {
        const list = pending.map((p, i) => `${i + 1}. ${p.penaltyRule.name} - ${p.penaltyRule.amount} RWF`).join('\n');
        return `CON Select penalty\n${list}`;
      }

      const penalty = pending[Number(parts[3]) - 1];
      if (!penalty) return 'END Invalid penalty selection.';

      if (parts.length === 4) {
        return 'CON Enter bank reference for penalty payment:';
      }

      const bankReference = parts[4]?.trim();
      if (!this.isReferenceValid(bankReference)) {
        return 'END Invalid bank reference. Use 4-40 letters/numbers.';
      }

      if (penalty.status === MemberPenaltyStatus.PAID) {
        return 'END This penalty is already paid.';
      }

      await this.prisma.memberPenalty.update({
        where: { id: penalty.id },
        data: { status: MemberPenaltyStatus.PAID, bankReference, paidAt: new Date() },
      });
      return 'END Penalty payment submitted successfully.';
    }

    return 'END Invalid penalty option.';
  }

  private async handleLoans(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Loans\n1. Request loan\n2. My loan status';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return 'END Invalid group selection.';

      const membership = await this.prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId } },
      });
      if (!membership || !membership.isActive) return 'END You are not an active member of this group.';

      const tenureMonths = (Date.now() - membership.joinedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (tenureMonths < 6) return 'END Loan request requires at least 6 months in the group.';

      if (parts.length === 3) return 'CON Enter loan amount (RWF):';
      const amount = Number(parts[3]);
      if (!Number.isFinite(amount) || amount < 1000) return 'END Invalid amount. Minimum is 1000 RWF.';

      if (parts.length === 4) return 'CON Enter short reason (e.g. medical, school, business):';
      const reason = parts[4]?.trim();
      if (!reason || reason.length < 3) return 'END Invalid reason.';

      await this.prisma.loan.create({
        data: { groupId: group.id, requesterId: userId, amount, reason, status: LoanStatus.PENDING },
      });
      return 'END Loan request submitted. Group staff will review.';
    }

    if (parts[1] === '2') {
      const counts = await this.prisma.loan.groupBy({
        by: ['status'],
        where: { requesterId: userId },
        _count: { _all: true },
      });
      if (counts.length === 0) return 'END You have no loan records yet.';

      const summary = [
        `PENDING: ${counts.find((c) => c.status === LoanStatus.PENDING)?._count._all ?? 0}`,
        `APPROVED: ${counts.find((c) => c.status === LoanStatus.APPROVED)?._count._all ?? 0}`,
        `DECLINED: ${counts.find((c) => c.status === LoanStatus.DECLINED)?._count._all ?? 0}`,
        `REPAID: ${counts.find((c) => c.status === LoanStatus.REPAID)?._count._all ?? 0}`,
      ].join('\n');

      return `END My loan status\n${summary}`;
    }

    return 'END Invalid loan option.';
  }

  private handleGroupDirectory(parts: string[], groups: MemberGroup[]) {
    if (parts.length === 1) {
      return `CON Select group\n${this.groupOptions(groups)}`;
    }

    const group = this.pickGroup(parts[1], groups);
    if (!group) return 'END Invalid group selection.';

    return `END ${group.name}\nContribution: ${group.contributionAmount} RWF\nBank: ${group.bankName ?? 'N/A'}\nA/C: ${group.bankAccountNumber ?? 'N/A'}`;
  }

  private groupOptions(groups: MemberGroup[]) {
    return groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
  }

  private pickGroup<T extends { id: string }>(selection: string, groups: T[]): T | null {
    const index = Number(selection) - 1;
    if (Number.isNaN(index) || index < 0 || index >= groups.length) return null;
    return groups[index];
  }

  private isReferenceValid(reference: string | undefined) {
    if (!reference) return false;
    return /^[A-Za-z0-9-]{4,40}$/.test(reference);
  }

  private calculateCurrentCycleWeek(groupCreatedAt: Date, frequency: GroupFrequency): number {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - groupCreatedAt.getTime());
    const dayMs = 24 * 60 * 60 * 1000;
    const elapsedDays = Math.floor(elapsedMs / dayMs);

    const cycleDays =
      frequency === GroupFrequency.WEEKLY ? 7 :
      frequency === GroupFrequency.BIWEEKLY ? 14 : 30;

    return Math.floor(elapsedDays / cycleDays) + 1;
  }

  private async persistSession(sessionId: string, userId: string, text: string) {
    const state = text ? 'CONTINUE' : 'OPEN';
    await this.prisma.ussdSession.upsert({
      where: { sessionId },
      update: { state, data: { lastText: text } },
      create: { sessionId, userId, state, data: { lastText: text } },
    });
  }
}
