import { Injectable } from '@nestjs/common';
import { GroupFrequency, LoanStatus, MemberPenaltyStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UssdRequestDto } from './dto/ussd-request.dto';

const MAX_USSD_LENGTH = 182;
const SESSION_TIMEOUT_SECONDS = 60;

type MemberGroup = {
  id: string;
  name: string;
  contributionAmount: number | null;
  frequency: GroupFrequency;
  createdAt: Date;
  bankName: string | null;
  bankAccountNumber: string | null;
  language: string;
};

@Injectable()
export class UssdService {
  constructor(private prisma: PrismaService) {}

  async handleUssd(dto: UssdRequestDto) {
    const { sessionId, phoneNumber, text } = dto;
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (!user) {
      return this.end('Welcome to IkiminaPass. Register first using your group invite process.');
    }

    // Session timeout check
    const session = await this.prisma.ussdSession.findUnique({ where: { sessionId } });
    if (session) {
      const idleSeconds = (Date.now() - session.updatedAt.getTime()) / 1000;
      if (idleSeconds > SESSION_TIMEOUT_SECONDS) {
        await this.prisma.ussdSession.update({
          where: { sessionId },
          data: { state: 'CLOSED' },
        });
        return this.end('Session expired due to inactivity. Dial again to continue.');
      }
    }

    const memberships = await this.prisma.groupMember.findMany({
      where: { userId: user.id, isActive: true },
      include: { group: true },
      orderBy: { joinedAt: 'asc' },
    });

    if (memberships.length === 0) {
      return this.end('You are not an active member of any group. Contact your treasurer.');
    }

    const groups: MemberGroup[] = memberships.map((m) => ({
      id: m.group.id,
      name: m.group.name,
      contributionAmount: m.group.contributionAmount,
      frequency: m.group.frequency,
      createdAt: m.group.createdAt,
      bankName: m.group.bankName,
      bankAccountNumber: m.group.bankAccountNumber,
      language: m.group.language,
    }));

    const parts = text ? text.split('*').filter(Boolean) : [];

    let response: string;
    if (parts.length === 0) {
      response = this.mainMenu();
    } else if (parts[0] === '1') {
      response = await this.handleContributions(parts, user.id, groups);
    } else if (parts[0] === '2') {
      response = await this.handleCreditScore(parts, user.id);
    } else if (parts[0] === '3') {
      response = await this.handleGroupInfo(parts, user.id, groups);
    } else if (parts[0] === '4') {
      response = await this.handleLoans(parts, user.id, groups);
    } else if (parts[0] === '5') {
      response = await this.handleReportIssue(parts, user.id, groups);
    } else if (parts[0] === '6') {
      response = await this.handleTreasurerMenu(parts, user.id, groups);
    } else if (parts[0] === '0') {
      response = this.handleLanguage(parts);
    } else {
      response = this.end('Invalid option.');
    }

    // Enforce 182-char limit
    if (response.length > MAX_USSD_LENGTH) {
      const prefix = response.startsWith('CON') ? 'CON ' : 'END ';
      response = prefix + response.slice(4, MAX_USSD_LENGTH - 3) + '...';
    }

    await this.persistSession(sessionId, user.id, text);
    return response;
  }

  private mainMenu() {
    return 'CON IkiminaPass\n1. My contributions\n2. My credit score\n3. Group info\n4. Request loan\n5. Report an issue\n6. Treasurer menu\n0. Language';
  }

  private async handleContributions(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Contributions\n1. This period status\n2. My history (last 5)\n3. Submit transaction ID';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const week = this.calcWeek(group.createdAt, group.frequency);
      const contrib = await this.prisma.contribution.findFirst({
        where: { groupId: group.id, userId, weekNumber: week },
      });
      const status = contrib ? contrib.status : 'NOT SUBMITTED';
      return this.end(`Period ${week}: ${status}\nAmount: ${group.contributionAmount ?? 0} RWF`);
    }

    if (parts[1] === '2') {
      const recent = await this.prisma.contribution.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { group: { select: { name: true } } },
      });
      if (recent.length === 0) return this.end('No contributions yet.');
      const rows = recent.map((c, i) => `${i + 1}.${c.group.name}:${c.amount}(${c.status})`).join('\n');
      return this.end(`History\n${rows}`);
    }

    if (parts[1] === '3') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      if (parts.length === 3) return 'CON Enter MoMo transaction ID:';

      const txId = parts[3]?.trim();
      if (!txId || txId.length < 5) return this.end('Invalid transaction ID.');

      const duplicate = await this.prisma.contribution.findFirst({
        where: { momoTransactionId: txId },
      });
      if (duplicate) return this.end('This transaction ID was already submitted.');

      const week = this.calcWeek(group.createdAt, group.frequency);
      await this.prisma.contribution.create({
        data: {
          groupId: group.id,
          userId,
          amount: group.contributionAmount ?? 0,
          weekNumber: week,
          momoTransactionId: txId,
          status: 'PENDING',
        },
      });
      return this.end('Contribution submitted. Awaiting treasurer confirmation.');
    }

    return this.end('Invalid option.');
  }

  private async handleCreditScore(parts: string[], userId: string) {
    if (parts.length === 1) {
      return 'CON Credit Score\n1. View my score\n2. What my score means\n3. Get report link (SMS)';
    }

    if (parts[1] === '1') {
      const score = await this.prisma.creditScore.findUnique({ where: { userId } });
      if (!score) return this.end('No score yet. Need 3+ months of contributions.');
      return this.end(`Score: ${score.score}/850\nRating: ${score.label}`);
    }

    if (parts[1] === '2') {
      return this.end('BUILDING<300 FAIR 300-549\nGOOD 550-749\nEXCELLENT 750+\nBased on payments,tenure,loans');
    }

    if (parts[1] === '3') {
      const share = await this.prisma.sharedCreditReport.findFirst({
        where: { userId, revoked: false, expiresAt: { gt: new Date() } },
      });
      if (share) return this.end(`Report link sent via SMS. Expires: ${share.expiresAt.toDateString()}`);
      return this.end('No active report link. Generate one in the app.');
    }

    return this.end('Invalid option.');
  }

  private async handleGroupInfo(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Group Info\n1. Next payout\n2. Announcements\n3. My share balance';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const dbGroup = await this.prisma.group.findUnique({
        where: { id: group.id },
        include: { rotationLogs: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      const order = (dbGroup?.rotationLogs[0]?.newOrder as string[]) ?? [];
      const idx = dbGroup?.rotationIndex ?? 0;
      const recipientId = order[idx];
      if (!recipientId) return this.end('Rotation not set up yet.');

      const recipient = await this.prisma.user.findUnique({
        where: { id: recipientId },
        select: { fullName: true },
      });
      return this.end(`Next payout: ${recipient?.fullName ?? 'Unknown'}`);
    }

    if (parts[1] === '2') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const events = await this.prisma.activityFeedEvent.findMany({
        where: { groupId: group.id, type: 'ANNOUNCEMENT' },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      if (events.length === 0) return this.end('No announcements.');
      const msgs = events.map((e, i) => `${i + 1}. ${(e.data as any).message}`).join('\n');
      return this.end(`Announcements\n${msgs}`);
    }

    if (parts[1] === '3') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const balance = await this.prisma.memberShareBalance.findUnique({
        where: { groupId_memberId: { groupId: group.id, memberId: userId } },
      });
      const fund = await this.prisma.groupFund.findUnique({ where: { groupId: group.id } });
      const shares = balance?.totalShares ?? 0;
      const pct =
        fund && fund.totalShares > 0 ? ((shares / fund.totalShares) * 100).toFixed(1) : '0.0';
      return this.end(`Shares: ${shares}\nOwnership: ${pct}%\nFund: ${fund?.totalBalance ?? 0} RWF`);
    }

    return this.end('Invalid option.');
  }

  private async handleLoans(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Loans\n1. Request loan\n2. My loan status';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const membership = await this.prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId } },
      });
      if (!membership?.isActive) return this.end('Not an active member.');

      const tenureMonths = (Date.now() - membership.joinedAt.getTime()) / (1000 * 60 * 60 * 24 * 30);
      const dbGroup = await this.prisma.group.findUnique({ where: { id: group.id }, select: { loanMinTenureMonths: true } });
      if (tenureMonths < (dbGroup?.loanMinTenureMonths ?? 6)) {
        return this.end(`Loan requires ${dbGroup?.loanMinTenureMonths ?? 6} months membership.`);
      }

      if (parts.length === 3) return 'CON Enter loan amount (RWF):';
      const amount = Number(parts[3]);
      if (!Number.isFinite(amount) || amount < 1000) return this.end('Invalid amount. Min 1000 RWF.');

      if (parts.length === 4) return 'CON Enter reason (medical/school/business):';
      const reason = parts[4]?.trim();
      if (!reason || reason.length < 3) return this.end('Invalid reason.');

      await this.prisma.loan.create({
        data: { groupId: group.id, requesterId: userId, amount, reason, status: LoanStatus.PENDING },
      });
      return this.end('Loan request submitted. Group will review.');
    }

    if (parts[1] === '2') {
      const counts = await this.prisma.loan.groupBy({
        by: ['status'],
        where: { requesterId: userId },
        _count: { _all: true },
      });
      if (counts.length === 0) return this.end('No loan records yet.');
      const summary = counts.map((c) => `${c.status}:${c._count._all}`).join(' ');
      return this.end(`Loans\n${summary}`);
    }

    return this.end('Invalid option.');
  }

  private async handleReportIssue(parts: string[], userId: string, groups: MemberGroup[]) {
    if (parts.length === 1) {
      return 'CON Report Issue\n1. Wrong contribution recorded\n2. I paid but not confirmed\n3. Other issue';
    }

    const typeMap: Record<string, string> = {
      '1': 'WRONG_AMOUNT_RECORDED',
      '2': 'CONTRIBUTION_NOT_RECORDED',
      '3': 'CONTRIBUTION_NOT_RECORDED',
    };

    if (['1', '2', '3'].includes(parts[1])) {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      if (parts.length === 3) return 'CON Describe issue (max 100 chars):';
      const description = parts[3]?.trim().slice(0, 100);
      if (!description || description.length < 3) return this.end('Description too short.');

      const week = this.calcWeek(group.createdAt, group.frequency);
      await this.prisma.dispute.create({
        data: {
          groupId: group.id,
          raiserId: userId,
          weekNumber: week,
          disputeType: typeMap[parts[1]] as any,
          claimDescription: description,
        },
      });
      return this.end('Issue reported. Treasurer will respond within 48 hours.');
    }

    return this.end('Invalid option.');
  }

  private async handleTreasurerMenu(parts: string[], userId: string, groups: MemberGroup[]) {
    // Check if user is treasurer of any group
    const treasurerOf = await this.prisma.groupMember.findFirst({
      where: { userId, role: 'TREASURER', isActive: true },
    });
    if (!treasurerOf) return this.end('Treasurer access required.');

    if (parts.length === 1) {
      return 'CON Treasurer Menu\n1. Confirm contribution\n2. Unconfirmed contributions\n3. Post announcement\n4. Subscription status';
    }

    if (parts[1] === '1') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      if (parts.length === 3) return 'CON Enter member phone number:';
      const phone = parts[3]?.trim();

      const member = await this.prisma.user.findUnique({ where: { phoneNumber: phone } });
      if (!member) return this.end('Member not found.');

      const week = this.calcWeek(group.createdAt, group.frequency);
      const contrib = await this.prisma.contribution.findFirst({
        where: { groupId: group.id, userId: member.id, weekNumber: week, status: 'PENDING' },
      });
      if (!contrib) return this.end('No pending contribution found for this member.');

      await this.prisma.contribution.update({
        where: { id: contrib.id },
        data: { status: 'VERIFIED', verifiedAt: new Date(), verifiedById: userId },
      });
      return this.end(`Contribution confirmed for ${member.fullName ?? phone}.`);
    }

    if (parts[1] === '2') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const week = this.calcWeek(group.createdAt, group.frequency);
      const pending = await this.prisma.contribution.findMany({
        where: { groupId: group.id, weekNumber: week, status: 'PENDING' },
        include: { user: { select: { fullName: true } } },
        take: 5,
      });
      if (pending.length === 0) return this.end('No unconfirmed contributions.');
      const list = pending.map((c, i) => `${i + 1}.${c.user.fullName ?? '?'}:${c.amount}`).join('\n');
      return this.end(`Unconfirmed\n${list}`);
    }

    if (parts[1] === '3') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      if (parts.length === 3) return 'CON Enter announcement (max 120 chars):';
      const msg = parts[3]?.trim().slice(0, 120);
      if (!msg || msg.length < 3) return this.end('Message too short.');

      await this.prisma.activityFeedEvent.create({
        data: { groupId: group.id, type: 'ANNOUNCEMENT', data: { message: msg, postedBy: userId } },
      });
      return this.end('Announcement posted.');
    }

    if (parts[1] === '4') {
      if (parts.length === 2) return `CON Select group\n${this.groupOptions(groups)}`;
      const group = this.pickGroup(parts[2], groups);
      if (!group) return this.end('Invalid group selection.');

      const sub = await this.prisma.groupSubscription.findFirst({
        where: { groupId: group.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!sub) return this.end('No subscription found.');
      return this.end(`Status: ${sub.status}\nTier: ${sub.tier}\nDue: ${sub.amountDue} RWF\nNext: ${sub.nextBillingDate.toDateString()}`);
    }

    return this.end('Invalid option.');
  }

  private handleLanguage(parts: string[]) {
    if (parts.length === 1) {
      return 'CON Language / Ururimi\n1. Kinyarwanda\n2. English\n3. French';
    }
    const langs: Record<string, string> = { '1': 'Kinyarwanda', '2': 'English', '3': 'French' };
    const lang = langs[parts[1]];
    if (!lang) return this.end('Invalid selection.');
    return this.end(`Language set to ${lang}. Restart session to apply.`);
  }

  private end(msg: string): string {
    return `END ${msg}`;
  }

  private groupOptions(groups: MemberGroup[]) {
    return groups.map((g, i) => `${i + 1}. ${g.name}`).join('\n');
  }

  private pickGroup<T extends { id: string }>(selection: string, groups: T[]): T | null {
    const index = Number(selection) - 1;
    if (Number.isNaN(index) || index < 0 || index >= groups.length) return null;
    return groups[index];
  }

  private calcWeek(groupCreatedAt: Date, frequency: GroupFrequency): number {
    const cycleDays =
      frequency === GroupFrequency.WEEKLY ? 7 :
      frequency === GroupFrequency.BIWEEKLY ? 14 : 30;
    const elapsedDays = Math.floor((Date.now() - groupCreatedAt.getTime()) / (24 * 60 * 60 * 1000));
    return Math.floor(elapsedDays / cycleDays) + 1;
  }

  private async persistSession(sessionId: string, userId: string, text: string) {
    const state = text ? 'CONTINUE' : 'OPEN';
    await this.prisma.ussdSession.upsert({
      where: { sessionId },
      update: { state, data: { lastText: text }, updatedAt: new Date() },
      create: { sessionId, userId, state, data: { lastText: text } },
    });
  }
}
