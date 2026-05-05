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
import { randomInt } from 'crypto';
import {
  SubscriptionTier,
  SubscriptionStatus,
  PaymentStatus,
  Role,
  NotificationType,
  NotificationChannel,
} from '@prisma/client';

export const SUBSCRIPTION_TIERS = [
  { tier: SubscriptionTier.STARTER,   min: 5,  max: 15,     price: 5000  },
  { tier: SubscriptionTier.GROWTH,    min: 16, max: 30,     price: 10000 },
  { tier: SubscriptionTier.COMMUNITY, min: 31, max: 60,     price: 18000 },
  { tier: SubscriptionTier.ENTERPRISE,min: 61, max: 999999, price: 30000 },
] as const;

const GRACE_PERIOD_DAYS = 7;
const TRIAL_DAYS = 30;
const ARCHIVE_AFTER_SUSPENDED_DAYS = 30;

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

  private async acquireJobLock(name: string, minutes = 15) {
    const now = new Date();
    const lockUntil = new Date(now.getTime() + minutes * 60 * 1000);
    const existing = await this.prisma.jobLock.findUnique({ where: { name } });

    if (!existing) {
      await this.prisma.jobLock.create({
        data: { name, owner: process.pid.toString(), lockedUntil: lockUntil },
      });
      return true;
    }

    if (existing.lockedUntil > now) return false;

    await this.prisma.jobLock.update({
      where: { name },
      data: { owner: process.pid.toString(), lockedUntil: lockUntil },
    });
    return true;
  }

  private async releaseJobLock(name: string) {
    await this.prisma.jobLock.updateMany({
      where: { name, owner: process.pid.toString() },
      data: { lockedUntil: new Date() },
    });
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

    const payment = await this.prisma.subscriptionPayment.create({
      data: {
        groupId,
        subscriptionId: sub.id,
        treasurerId: userId,
        amountPaid: sub.amountDue,
        status: PaymentStatus.CONFIRMED,
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

    if (sub.status === SubscriptionStatus.SUSPENDED || sub.status === SubscriptionStatus.ARCHIVED) {
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
    const tierOrder = SUBSCRIPTION_TIERS.map((t) => t.tier as string);
    const isUpgrade =
      tierOrder.indexOf(tierConfig.tier as string) > tierOrder.indexOf(previousTier as string);

    await this.prisma.groupSubscription.update({
      where: { id: currentSub.id },
      data: {
        tier: tierConfig.tier,
        amountDue: tierConfig.price,
        memberCountAtBilling: activeMembersCount,
      },
    });

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

  // Daily 08:00 — initiate billing for groups whose nextBillingDate is today
  @Cron('0 8 * * *')
  async handleDailyBilling() {
    const lockName = 'subscriptions:daily_billing';
    if (!(await this.acquireJobLock(lockName))) return;
    try {
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

        // Mock MoMo requestToPay — replace with real API in production
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
    } finally {
      await this.releaseJobLock(lockName);
    }
  }

  // Daily 09:00 — send reminders to treasurers of OVERDUE groups
  @Cron('0 9 * * *')
  async handleGracePeriodReminders() {
    const lockName = 'subscriptions:grace_reminders';
    if (!(await this.acquireJobLock(lockName))) return;
    try {
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
    } finally {
      await this.releaseJobLock(lockName);
    }
  }

  // Daily 06:00 — warn treasurers whose trial ends in 7 days
  @Cron('0 6 * * *')
  async handleTrialWarnings() {
    const lockName = 'subscriptions:trial_warnings';
    if (!(await this.acquireJobLock(lockName))) return;
    try {
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
    } finally {
      await this.releaseJobLock(lockName);
    }
  }

  // Daily 10:00 — suspend groups whose 7-day grace period has expired
  @Cron('0 10 * * *')
  async handleSuspensions() {
    const lockName = 'subscriptions:suspensions';
    if (!(await this.acquireJobLock(lockName))) return;
    try {
      this.logger.log('Checking for groups to suspend...');

      const graceCutoff = new Date();
      graceCutoff.setDate(graceCutoff.getDate() - GRACE_PERIOD_DAYS);

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
    } finally {
      await this.releaseJobLock(lockName);
    }
  }

  // Daily 11:00 — archive groups suspended for 30+ days
  @Cron('0 11 * * *')
  async handleArchiving() {
    const lockName = 'subscriptions:archiving';
    if (!(await this.acquireJobLock(lockName))) return;
    try {
      this.logger.log('Checking for groups to archive...');

      const archiveCutoff = new Date();
      archiveCutoff.setDate(archiveCutoff.getDate() - ARCHIVE_AFTER_SUSPENDED_DAYS);

      const toArchive = await this.prisma.group.findMany({
        where: {
          isSuspended: true,
          suspendedAt: { lt: archiveCutoff },
          subscriptionStatus: SubscriptionStatus.SUSPENDED,
        },
        select: { id: true },
      });

      for (const group of toArchive) {
        await this.prisma.groupSubscription.updateMany({
          where: { groupId: group.id, status: SubscriptionStatus.SUSPENDED },
          data: { status: SubscriptionStatus.ARCHIVED },
        });

        await this.prisma.group.update({
          where: { id: group.id },
          data: { subscriptionStatus: SubscriptionStatus.ARCHIVED },
        });

        this.logger.log(`Group ${group.id} archived after 30 days suspended`);
      }
    } finally {
      await this.releaseJobLock(lockName);
    }
  }

  // Daily 08:00 — 7-day and 3-day billing reminders before next billing date
  @Cron('0 12 * * *')
  async handleBillingReminders() {
    const lockName = 'subscriptions:billing_reminders';
    if (!(await this.acquireJobLock(lockName))) return;
    try {
      const in7Days = new Date();
      in7Days.setDate(in7Days.getDate() + 7);
      const in8Days = new Date(in7Days);
      in8Days.setDate(in8Days.getDate() + 1);

      const in3Days = new Date();
      in3Days.setDate(in3Days.getDate() + 3);
      const in4Days = new Date(in3Days);
      in4Days.setDate(in4Days.getDate() + 1);

      const [upcoming7, upcoming3] = await Promise.all([
        this.prisma.groupSubscription.findMany({
          where: {
            status: SubscriptionStatus.ACTIVE,
            nextBillingDate: { gte: in7Days, lt: in8Days },
          },
          include: {
            group: { include: { members: { where: { role: Role.TREASURER, isActive: true } } } },
          },
        }),
        this.prisma.groupSubscription.findMany({
          where: {
            status: SubscriptionStatus.ACTIVE,
            nextBillingDate: { gte: in3Days, lt: in4Days },
          },
          include: {
            group: { include: { members: { where: { role: Role.TREASURER, isActive: true } } } },
          },
        }),
      ]);

      for (const sub of upcoming7) {
        const treasurer = sub.group.members[0];
        if (!treasurer) continue;
        await this.notifications.sendNotification(
          treasurer.userId,
          NotificationType.SUBSCRIPTION_PAYMENT_DUE,
          `Reminder: Your group "${sub.group.name}" subscription of ${sub.amountDue} RWF is due in 7 days.`,
          NotificationChannel.SMS,
        );
      }

      for (const sub of upcoming3) {
        const treasurer = sub.group.members[0];
        if (!treasurer) continue;
        await this.notifications.sendNotification(
          treasurer.userId,
          NotificationType.BILLING_REMINDER,
          `Urgent: Your group "${sub.group.name}" subscription of ${sub.amountDue} RWF is due in 3 days.`,
          NotificationChannel.SMS,
        );
      }
    } finally {
      await this.releaseJobLock(lockName);
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

  // ── Referral Program ────────────────────────────────────────────────────────

  async getMyReferralCode(userId: string): Promise<{ referralCode: string }> {
    let user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { referralCode: true },
    });
    if (!user) throw new ForbiddenException('User not found');

    if (!user.referralCode) {
      // Generate a unique 8-char referral code
      const code = await this.generateUniqueReferralCode();
      await this.prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return { referralCode: code };
    }

    return { referralCode: user.referralCode };
  }

  async getMyReferrals(userId: string) {
    return this.prisma.referralLog.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      include: { referredUser: { select: { fullName: true, phoneNumber: true } } },
    });
  }

  private async generateUniqueReferralCode(): Promise<string> {
    // 8-digit numeric code — easy to type on button phones
    for (let i = 0; i < 10; i++) {
      const code = randomInt(10000000, 99999999).toString();
      const existing = await this.prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
      if (!existing) return code;
    }
    throw new Error('Could not generate unique referral code');
  }

  // Daily 07:00 — check referrals that have completed 3 months and grant free month
  @Cron('0 7 * * *')
  async processReferralRewards() {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // Find PENDING referrals where the referred user's group has been active for 3+ months
    const pendingReferrals = await this.prisma.referralLog.findMany({
      where: { status: 'PENDING', createdAt: { lte: threeMonthsAgo } },
      include: {
        referredUser: {
          include: {
            groupMembers: {
              where: { role: Role.TREASURER, isActive: true },
              include: {
                group: {
                  include: { subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 } },
                },
              },
            },
          },
        },
        referrer: { select: { id: true, fullName: true } },
      },
    });

    for (const referral of pendingReferrals) {
      // Check referred user's group has an active paid subscription
      const hasActiveSub = referral.referredUser.groupMembers.some((m) => {
        const sub = m.group.subscriptions[0];
        return sub?.status === 'ACTIVE';
      });

      if (!hasActiveSub) continue;

      // Grant referrer 1 free month by extending their group's next billing date
      const referrerGroup = await this.prisma.groupMember.findFirst({
        where: { userId: referral.referrerId, role: Role.TREASURER, isActive: true },
        include: { group: { include: { subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 } } } },
      });

      if (referrerGroup?.group.subscriptions[0]) {
        const sub = referrerGroup.group.subscriptions[0];
        const newBillingDate = new Date(sub.nextBillingDate);
        newBillingDate.setMonth(newBillingDate.getMonth() + 1);

        await this.prisma.groupSubscription.update({
          where: { id: sub.id },
          data: { nextBillingDate: newBillingDate },
        });

        await this.prisma.referralLog.update({
          where: { id: referral.id },
          data: { status: 'REWARDED' },
        });

        await this.prisma.auditLog.create({
          data: {
            actorId: referral.referrerId,
            actionType: 'REFERRAL_REWARD_GRANTED',
            targetId: referral.id,
            metadata: { freeMonthExtendedTo: newBillingDate.toISOString() },
          },
        });

        this.logger.log(`Referral reward granted to ${referral.referrer.fullName} — 1 free month`);
      }
    }
  }
}
