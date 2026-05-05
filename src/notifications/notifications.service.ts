import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SmsService } from '../integrations/sms.service';
import { NotificationType, NotificationChannel, NotificationStatus } from '@prisma/client';
import { UpdateNotificationSettingsDto } from './dto/update-settings.dto';
import { Cron } from '@nestjs/schedule';

const MAX_RETRIES = 3;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private sms: SmsService,
  ) {}

  async sendNotification(
    userId: string,
    type: NotificationType,
    message: string,
    channel: NotificationChannel,
  ) {
    const setting = await this.prisma.notificationSetting.findUnique({
      where: { userId_type: { userId, type } },
    });

    if (setting && !setting.enabled) return;

    const notification = await this.prisma.notification.create({
      data: { recipientId: userId, type, message, channel, status: NotificationStatus.PENDING },
    });

    await this.dispatchWithRetry(notification.id, userId, message, channel, 1);
  }

  private async dispatchWithRetry(
    notificationId: string,
    userId: string,
    message: string,
    channel: NotificationChannel,
    attempt: number,
  ) {
    try {
      if (channel === NotificationChannel.SMS) {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { phoneNumber: true },
        });
        if (user?.phoneNumber) {
          await this.sms.sendSms(user.phoneNumber, message);
        }
      } else {
        // PUSH — log until FCM is integrated
        this.logger.log(`[PUSH] To ${userId}: ${message}`);
      }

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.SENT, retryCount: attempt - 1 },
      });
    } catch (e) {
      this.logger.error(`Notification attempt ${attempt} failed: ${e.message}`);

      if (attempt >= MAX_RETRIES) {
        await this.prisma.notification.update({
          where: { id: notificationId },
          data: { status: NotificationStatus.PERMANENTLY_FAILED, retryCount: attempt },
        });
        return;
      }

      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { status: NotificationStatus.FAILED, retryCount: attempt },
      });

      const delay = Math.pow(2, attempt) * 1000;
      setTimeout(
        () => this.dispatchWithRetry(notificationId, userId, message, channel, attempt + 1),
        delay,
      );
    }
  }

  async getMyNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { recipientId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async updateSettings(userId: string, dto: UpdateNotificationSettingsDto) {
    return this.prisma.notificationSetting.upsert({
      where: { userId_type: { userId, type: dto.type } },
      update: { enabled: dto.enabled },
      create: { userId, type: dto.type, enabled: dto.enabled },
    });
  }

  // 24 hours before contribution deadline — remind members with no submission
  // Runs at 08:00 daily
  @Cron('0 8 * * *')
  async sendContributionReminders() {
    this.logger.log('Sending contribution reminders...');

    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const activeGroups = await this.prisma.group.findMany({
        where: { isSuspended: false },
        take: 500,
        skip: cursor ? 1 : 0,
        ...(cursor ? { cursor: { id: cursor } } : {}),
        include: { members: { where: { isActive: true }, select: { userId: true } } },
      });

      if (activeGroups.length === 0) {
        hasMore = false;
        break;
      }

      cursor = activeGroups[activeGroups.length - 1].id;

      for (const group of activeGroups) {
        // Calculate current week
        const cycleDays =
          group.frequency === 'WEEKLY' ? 7 : group.frequency === 'BIWEEKLY' ? 14 : 30;
        const elapsedDays = Math.floor((Date.now() - group.createdAt.getTime()) / (24 * 60 * 60 * 1000));
        const currentWeek = Math.floor(elapsedDays / cycleDays) + 1;

        // Days until end of current period
        const periodEndDay = currentWeek * cycleDays;
        const daysLeft = periodEndDay - elapsedDays;

        if (daysLeft !== 1) continue; // only remind 24h before deadline

        for (const member of group.members) {
          const submitted = await this.prisma.contribution.findFirst({
            where: { groupId: group.id, userId: member.userId, weekNumber: currentWeek },
          });

          if (!submitted) {
            await this.sendNotification(
              member.userId,
              NotificationType.CONTRIBUTION_REMINDER,
              `Reminder: Your contribution of ${group.contributionAmount ?? 0} RWF for "${group.name}" is due tomorrow.`,
              NotificationChannel.SMS,
            );
          }
        }
      }
    }
  }

  // Day after deadline — notify members who still haven't submitted
  // Runs at 09:00 daily (already distinct from contribution reminders)
  @Cron('0 9 * * *')
  async sendContributionOverdueNotices() {
    this.logger.log('Sending contribution overdue notices...');

    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      const activeGroups = await this.prisma.group.findMany({
        where: { isSuspended: false },
        take: 500,
        skip: cursor ? 1 : 0,
        ...(cursor ? { cursor: { id: cursor } } : {}),
        include: { members: { where: { isActive: true }, select: { userId: true } } },
      });

      if (activeGroups.length === 0) {
        hasMore = false;
        break;
      }

      cursor = activeGroups[activeGroups.length - 1].id;

      for (const group of activeGroups) {
        const cycleDays =
          group.frequency === 'WEEKLY' ? 7 : group.frequency === 'BIWEEKLY' ? 14 : 30;
        const elapsedDays = Math.floor((Date.now() - group.createdAt.getTime()) / (24 * 60 * 60 * 1000));
        const currentWeek = Math.floor(elapsedDays / cycleDays) + 1;
        const periodEndDay = currentWeek * cycleDays;
        const daysOverdue = elapsedDays - periodEndDay;

        if (daysOverdue !== 1) continue; // only on day 1 after deadline

        for (const member of group.members) {
          const submitted = await this.prisma.contribution.findFirst({
            where: { groupId: group.id, userId: member.userId, weekNumber: currentWeek },
          });

          if (!submitted) {
            await this.sendNotification(
              member.userId,
              NotificationType.CONTRIBUTION_OVERDUE,
              `Your contribution for "${group.name}" period ${currentWeek} is overdue. Submit now to avoid a MISSED mark.`,
              NotificationChannel.SMS,
            );
          }
        }
      }
    }
  }

  // Daily at 10:00 — send loan repayment reminders 3 days before installment due
  @Cron('0 10 * * *')
  async sendLoanRepaymentReminders() {
    const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    let cursor: string | undefined = undefined;
    let hasMore = true;

    while (hasMore) {
      // Find approved loans disbursed such that a monthly installment is due in 3 days
      const approvedLoans = await this.prisma.loan.findMany({
        where: { status: 'APPROVED' },
        take: 500,
        skip: cursor ? 1 : 0,
        ...(cursor ? { cursor: { id: cursor } } : {}),
        include: { repayments: true },
      });

      if (approvedLoans.length === 0) {
        hasMore = false;
        break;
      }

      cursor = approvedLoans[approvedLoans.length - 1].id;

      for (const loan of approvedLoans) {
        if (!loan.disbursedAt) continue;

        const totalRepaid = loan.repayments.reduce((s, r) => s + r.amount, 0);
        if (totalRepaid >= loan.totalRepayable) continue;

        // Calculate next installment due date
        const monthlyInstallment = Math.ceil(loan.totalRepayable / loan.repaymentMonths);
        const monthsPaid = Math.floor(totalRepaid / monthlyInstallment);
        const nextDueDate = new Date(loan.disbursedAt);
        nextDueDate.setMonth(nextDueDate.getMonth() + monthsPaid + 1);

        const daysUntilDue = Math.floor((nextDueDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

        if (daysUntilDue === 3) {
          await this.sendNotification(
            loan.requesterId,
            NotificationType.LOAN_REPAYMENT_DUE,
            `Reminder: Your loan installment of ${monthlyInstallment} RWF is due in 3 days.`,
            NotificationChannel.SMS,
          );
        } else if (daysUntilDue < 0) {
          await this.sendNotification(
            loan.requesterId,
            NotificationType.LOAN_REPAYMENT_LATE,
            `Your loan repayment installment is overdue. Please repay immediately to avoid default.`,
            NotificationChannel.SMS,
          );
        }
      }
    }
  }
}
