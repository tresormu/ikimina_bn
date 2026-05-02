import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Cron } from '@nestjs/schedule';
import {
  SubscriptionTier,
  SubscriptionStatus,
  PaymentStatus,
  Role,
  NotificationType,
  NotificationChannel,
} from '@prisma/client';

export const SUBSCRIPTION_TIERS = [
  { tier: SubscriptionTier.STARTER, min: 1, max: 10, price: 5000 },
  { tier: SubscriptionTier.GROWTH, min: 11, max: 25, price: 10500 },
  { tier: SubscriptionTier.COMMUNITY, min: 26, max: 50, price: 25000 },
  { tier: SubscriptionTier.ENTERPRISE, min: 51, max: Infinity, price: 32000 },
] as const;

const GRACE_PERIOD_DAYS = 5;
const TRIAL_DAYS = 30;

@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  getTiers() {
    return SUBSCRIPTION_TIERS;
  }

  async getGroupSubscription(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    const sub = await this.prisma.groupSubscription.findFirst({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  async getSubscriptionHistory(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.subscriptionPayment.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      include: { treasurer: { select: { fullName: true, phoneNumber: true } } },
    });
  }

  async manualPay(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);

    const sub = await this.prisma.groupSubscription.findFirst({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
    });

    if (!sub) throw new NotFoundException('No subscription found');
    if (sub.status === SubscriptionStatus.ACTIVE || sub.status === SubscriptionStatus.TRIAL) {
      throw new BadRequestException('Subscription is already active');
    }

    const treasurer = await this.prisma.user.findUnique({ where: { id: userId } });

    this.logger.log(
      `Initiating MoMo requestToPay: ${sub.amountDue} RWF from ${treasurer?.phoneNumber}`,
    );

    // Create PENDING payment record — in production, MoMo webhook confirms it
    const payment = await this.prisma.subscriptionPayment.create({
      data: {
        groupId,
        subscriptionId: sub.id,
        treasurerId: userId,
        amountPaid: sub.amountDue,
        status: PaymentStatus.CONFIRMED, // Mock: immediate success
        momoTransactionId: `MOCK_TX_${Date.now()}`,
        paidAt: new Date(),
        attemptNumber: 1,
      },
    });

    const nextBillingDate = new Date();
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

    await this.prisma.groupSubscription.update({
      where: { id: sub.id },
      data: {
        status: SubscriptionStatus.ACTIVE,
        lastPaidAt: new Date(),
        nextBillingDate,
      },
    });

    await this.prisma.group.update({
      where: { id: groupId },
      data: {
        isSuspended: false,
        suspendedAt: null,
        suspensionReason: null,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
      },
    });

    await this.notifications.sendNotification(
      userId,
      NotificationType.SUBSCRIPTION_PAYMENT_SUCCESS,
      `Payment of ${sub.amountDue} RWF confirmed. Your group subscription is now active.`,
      NotificationChannel.SMS,
    );

    // Notify all members of reactivation if group was suspended
    if (sub.status === SubscriptionStatus.SUSPENDED) {
      const group = await this.prisma.group.findUnique({ where: { id: groupId } });
      const members = await this.prisma.groupMember.findMany({
        where: { groupId, isActive: true },
        select: { userId: true },
      });
      await Promise.all(
        members.map((m) =>
          this.notifications.sendNotification(
            m.userId,
            NotificationType.GROUP_REACTIVATED,
            `Good news! Your group "${group?.name}" has been reactivated.`,
            NotificationChannel.SMS,
          ),
        ),
      );
    }

    return { message: 'Payment successful, group reactivated.', payment };
  }

  // Called whenever a member joins or is deactivated
  async recalculateTier(groupId: string) {
    const activeMembersCount = await this.prisma.groupMember.count({
      where: { groupId, isActive: true },
    });

    const tierConfig = SUBSCRIPTION_TIERS.find(
      (t) => activeMembersCount >= t.min && activeMembersCount <= t.max,
    );

    if (!tierConfig) return;

    const currentSub = await this.prisma.groupSubscription.findFirst({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
    });

    if (!currentSub || currentSub.tier === tierConfig.tier) return;

    const previousTier = currentSub.tier;
    const tierOrder = SUBSCRIPTION_TIERS.map((t) => t.tier);
    const isUpgrade = tierOrder.indexOf(tierConfig.tier) > tierOrder.indexOf(previousTier);

    await this.prisma.groupSubscription.update({
      where: { id: currentSub.id },
      data: {
        tier: tierConfig.tier,
        amountDue: tierConfig.price,
        memberCountAtBilling: activeMembersCount,
      },
    });

    // Find treasurer to notify
    const treasurerMembership = await this.prisma.groupMember.findFirst({
      where: { groupId, role: Role.TREASURER, isActive: true },
    });

    if (treasurerMembership) {
      const notifType = isUpgrade
        ? NotificationType.SUBSCRIPTION_TIER_UPGRADED
        : NotificationType.SUBSCRIPTION_TIER_DOWNGRADED;

      const direction = isUpgrade ? 'upgraded' : 'downgraded';
      await this.notifications.sendNotification(
        treasurerMembership.userId,
        notifType,
        `Your group subscription has been ${direction} from ${previousTier} to ${tierConfig.tier}. New monthly fee: ${tierConfig.price} RWF.`,
        NotificationChannel.SMS,
      );
    }

    this.logger.log(`Group ${groupId} tier changed: ${previousTier} → ${tierConfig.tier}`);
  }

  // --- CRON JOBS ---

  // Daily 08:00 — initiate billing for groups whose nextBillingDate is today
  @Cron('0 8 * * *')
  async handleDailyBilling() {
    this.logger.log('Running daily billing cron...');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const dueSubs = await this.prisma.groupSubscription.findMany({
      where: {
        nextBillingDate: { gte: today, lt: tomorrow },
        status: SubscriptionStatus.ACTIVE,
      },
      include: {
        group: {
          include: {
            members: { where: { role: Role.TREASURER, isActive: true } },
          },
        },
      },
    });

    for (const sub of dueSubs) {
      const treasurer = sub.group.members[0];
      if (!treasurer) continue;

      this.logger.log(`Billing group ${sub.groupId} — ${sub.amountDue} RWF`);

      // Mock MoMo requestToPay — in production integrate real API
      const mockSuccess = true;

      if (mockSuccess) {
        const nextBillingDate = new Date();
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

        await this.prisma.subscriptionPayment.create({
          data: {
            groupId: sub.groupId,
            subscriptionId: sub.id,
            treasurerId: treasurer.userId,
            amountPaid: sub.amountDue,
            status: PaymentStatus.CONFIRMED,
            momoTransactionId: `AUTO_TX_${Date.now()}`,
            paidAt: new Date(),
            attemptNumber: 1,
          },
        });

        await this.prisma.groupSubscription.update({
          where: { id: sub.id },
          data: { lastPaidAt: new Date(), nextBillingDate },
        });

        await this.notifications.sendNotification(
          treasurer.userId,
          NotificationType.SUBSCRIPTION_PAYMENT_SUCCESS,
          `Monthly subscription of ${sub.amountDue} RWF collected successfully.`,
          NotificationChannel.SMS,
        );
      } else {
        // Mark overdue, retry logic handled by separate cron
        await this.prisma.groupSubscription.update({
          where: { id: sub.id },
          data: { status: SubscriptionStatus.OVERDUE },
        });

        await this.prisma.group.update({
          where: { id: sub.groupId },
          data: { subscriptionStatus: SubscriptionStatus.OVERDUE },
        });

        await this.notifications.sendNotification(
          treasurer.userId,
          NotificationType.SUBSCRIPTION_PAYMENT_FAILED,
          `We could not collect your subscription of ${sub.amountDue} RWF. Please ensure funds are available.`,
          NotificationChannel.SMS,
        );
      }
    }
  }

  // Daily 09:00 — send daily reminders to treasurers of OVERDUE groups
  @Cron('0 9 * * *')
  async handleGracePeriodReminders() {
    this.logger.log('Sending grace period reminders...');

    const overdueSubs = await this.prisma.groupSubscription.findMany({
      where: { status: SubscriptionStatus.OVERDUE },
      include: {
        group: {
          include: { members: { where: { role: Role.TREASURER, isActive: true } } },
        },
      },
    });

    for (const sub of overdueSubs) {
      const treasurer = sub.group.members[0];
      if (!treasurer) continue;

      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.SUBSCRIPTION_GRACE_PERIOD_WARNING,
        `Your group "${sub.group.name}" subscription payment of ${sub.amountDue} RWF is overdue. Pay now to avoid suspension.`,
        NotificationChannel.SMS,
      );
    }
  }

  // Daily 06:00 — warn treasurers whose trial ends in 7 days
  @Cron('0 6 * * *')
  async handleTrialWarnings() {
    this.logger.log('Checking trial expiry warnings...');

    const in7Days = new Date();
    in7Days.setDate(in7Days.getDate() + 7);
    const in8Days = new Date(in7Days);
    in8Days.setDate(in8Days.getDate() + 1);

    const expiringSubs = await this.prisma.groupSubscription.findMany({
      where: {
        status: SubscriptionStatus.TRIAL,
        trialEndsAt: { gte: in7Days, lt: in8Days },
      },
      include: {
        group: {
          include: { members: { where: { role: Role.TREASURER, isActive: true } } },
        },
      },
    });

    for (const sub of expiringSubs) {
      const treasurer = sub.group.members[0];
      if (!treasurer) continue;

      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.SUBSCRIPTION_TRIAL_ENDING,
        `Your free trial for group "${sub.group.name}" ends in 7 days. Your plan: ${sub.tier} at ${sub.amountDue} RWF/month.`,
        NotificationChannel.SMS,
      );
    }
  }

  // Daily 10:00 — suspend groups whose grace period (5 days overdue) has expired
  @Cron('0 10 * * *')
  async handleSuspensions() {
    this.logger.log('Checking for groups to suspend...');

    const graceCutoff = new Date();
    graceCutoff.setDate(graceCutoff.getDate() - GRACE_PERIOD_DAYS);

    // Find OVERDUE subscriptions where nextBillingDate passed more than GRACE_PERIOD_DAYS ago
    const overdueExpired = await this.prisma.groupSubscription.findMany({
      where: {
        status: SubscriptionStatus.OVERDUE,
        nextBillingDate: { lt: graceCutoff },
      },
      include: {
        group: {
          include: { members: { where: { isActive: true }, select: { userId: true } } },
        },
      },
    });

    for (const sub of overdueExpired) {
      await this.prisma.groupSubscription.update({
        where: { id: sub.id },
        data: { status: SubscriptionStatus.SUSPENDED },
      });

      await this.prisma.group.update({
        where: { id: sub.groupId },
        data: {
          isSuspended: true,
          suspendedAt: new Date(),
          suspensionReason: 'Subscription payment overdue',
          subscriptionStatus: SubscriptionStatus.SUSPENDED,
        },
      });

      // Notify all active members
      await Promise.all(
        sub.group.members.map((m) =>
          this.notifications.sendNotification(
            m.userId,
            NotificationType.GROUP_SUSPENDED,
            `Your group "${sub.group.name}" has been suspended due to an unpaid subscription. Contact your treasurer.`,
            NotificationChannel.SMS,
          ),
        ),
      );

      this.logger.log(`Group ${sub.groupId} suspended due to non-payment`);
    }
  }

  // Daily 08:00 — 7 days before billing date, send payment due reminder
  @Cron('0 8 * * *')
  async handleBillingReminders() {
    const in7Days = new Date();
    in7Days.setDate(in7Days.getDate() + 7);
    const in8Days = new Date(in7Days);
    in8Days.setDate(in8Days.getDate() + 1);

    const upcomingSubs = await this.prisma.groupSubscription.findMany({
      where: {
        status: SubscriptionStatus.ACTIVE,
        nextBillingDate: { gte: in7Days, lt: in8Days },
      },
      include: {
        group: {
          include: { members: { where: { role: Role.TREASURER, isActive: true } } },
        },
      },
    });

    for (const sub of upcomingSubs) {
      const treasurer = sub.group.members[0];
      if (!treasurer) continue;

      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.SUBSCRIPTION_PAYMENT_DUE,
        `Reminder: Your group "${sub.group.name}" subscription of ${sub.amountDue} RWF is due in 7 days.`,
        NotificationChannel.SMS,
      );
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
