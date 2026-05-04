import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType, NotificationChannel, NotificationStatus } from '@prisma/client';
import { UpdateNotificationSettingsDto } from './dto/update-settings.dto';
import { Cron } from '@nestjs/schedule';

const MAX_RETRIES = 3;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

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
        this.logger.log(`[SMS] To ${userId}: ${message}`);
      } else {
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

      // Exponential backoff: 2^attempt * 1000ms (2s, 4s)
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

  // 24 hours before contribution deadline — remind all members with unpaid status
  @Cron('0 8 * * 6') // Every Saturday at 08:00 (day before Sunday deadline)
  async sendWeeklyReminders() {
    this.logger.log('Sending weekly contribution reminders...');
    const pageSize = 1000;
    let cursor: string | null = null;

    while (true) {
      const pendingContributions = await this.prisma.contribution.findMany({
        where: { status: 'PENDING' },
        include: { user: { select: { id: true } }, group: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (pendingContributions.length === 0) break;

      for (const c of pendingContributions) {
        await this.sendNotification(
          c.user.id,
          NotificationType.WEEKLY_REMINDER,
          `Reminder: Your contribution of ${c.amount} RWF for group "${c.group.name}" is due tomorrow.`,
          NotificationChannel.SMS,
        );
      }

      cursor = pendingContributions[pendingContributions.length - 1].id;
    }
  }
}
