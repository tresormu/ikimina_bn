import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationChannel, NotificationType, SubscriptionStatus } from '@prisma/client';
import {
  ApproveRejectLenderDto,
  RejectLenderDto,
  SuspendGroupDto,
  ResolveDisputeAdminDto,
  PlatformAnnouncementDto,
  SearchUserDto,
  OverrideSubscriptionDto,
} from './dto/admin.dto';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async getAllGroups() {
    return this.prisma.group.findMany({
      include: {
        _count: { select: { members: true } },
        subscriptions: { take: 1, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getAllLenders() {
    return this.prisma.lender.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async approveLender(id: string, dto: ApproveRejectLenderDto) {
    const lender = await this.prisma.lender.findUnique({ where: { id } });
    if (!lender) throw new NotFoundException('Lender not found');

    await this.prisma.lender.update({
      where: { id },
      data: { isApproved: true },
    });

    await this.prisma.auditLog.create({
      data: { actionType: 'LENDER_APPROVED', targetId: id, metadata: { note: dto.note } },
    });

    return { message: 'Lender approved' };
  }

  async rejectLender(id: string, dto: RejectLenderDto) {
    const lender = await this.prisma.lender.findUnique({ where: { id } });
    if (!lender) throw new NotFoundException('Lender not found');

    await this.prisma.lender.update({
      where: { id },
      data: { isApproved: false },
    });

    await this.prisma.auditLog.create({
      data: { actionType: 'LENDER_REJECTED', targetId: id, metadata: { reason: dto.reason } },
    });

    return { message: 'Lender rejected' };
  }

  async suspendLender(id: string) {
    const lender = await this.prisma.lender.findUnique({ where: { id } });
    if (!lender) throw new NotFoundException('Lender not found');

    await this.prisma.lender.update({ where: { id }, data: { isSuspended: true } });

    await this.prisma.auditLog.create({
      data: { actionType: 'LENDER_SUSPENDED', targetId: id },
    });

    return { message: 'Lender suspended' };
  }

  async suspendGroup(id: string, dto: SuspendGroupDto) {
    const group = await this.prisma.group.findUnique({ where: { id } });
    if (!group) throw new NotFoundException('Group not found');

    await this.prisma.group.update({
      where: { id },
      data: {
        isSuspended: true,
        suspendedAt: new Date(),
        suspensionReason: dto.reason,
        subscriptionStatus: SubscriptionStatus.SUSPENDED,
      },
    });

    await this.prisma.groupSubscription.updateMany({
      where: { groupId: id },
      data: { status: SubscriptionStatus.SUSPENDED },
    });

    // Notify all active members
    const members = await this.prisma.groupMember.findMany({
      where: { groupId: id, isActive: true },
      select: { userId: true },
    });

    await Promise.all(
      members.map((m) =>
        this.notifications.sendNotification(
          m.userId,
          NotificationType.GROUP_SUSPENDED,
          `Your group "${group.name}" has been suspended by admin. Reason: ${dto.reason}`,
          NotificationChannel.SMS,
        ),
      ),
    );

    await this.prisma.auditLog.create({
      data: { actionType: 'GROUP_SUSPENDED', targetId: id, metadata: { reason: dto.reason } },
    });

    return { message: 'Group suspended' };
  }

  async getAllDisputes() {
    return this.prisma.dispute.findMany({
      where: { status: 'ESCALATED' },
      include: {
        raiser: { select: { fullName: true, phoneNumber: true } },
        group: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolveDispute(id: string, dto: ResolveDisputeAdminDto, adminId: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found');

    await this.prisma.dispute.update({
      where: { id },
      data: { status: 'CLOSED', resolutionNote: dto.resolutionNote },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actionType: 'DISPUTE_RESOLVED',
        targetId: id,
        metadata: { resolutionNote: dto.resolutionNote },
      },
    });

    return { message: 'Dispute resolved' };
  }

  async getRevenue() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const [
      totalAllTime,
      totalThisMonth,
      totalLastMonth,
      byTier,
      groupsPerTier,
      trialCount,
      suspendedCount,
    ] = await Promise.all([
      this.prisma.subscriptionPayment.aggregate({
        where: { status: 'CONFIRMED' },
        _sum: { amountPaid: true },
      }),
      this.prisma.subscriptionPayment.aggregate({
        where: { status: 'CONFIRMED', paidAt: { gte: startOfMonth } },
        _sum: { amountPaid: true },
      }),
      this.prisma.subscriptionPayment.aggregate({
        where: {
          status: 'CONFIRMED',
          paidAt: { gte: startOfLastMonth, lt: startOfMonth },
        },
        _sum: { amountPaid: true },
      }),
      this.prisma.subscriptionPayment.groupBy({
        by: ['subscriptionId'],
        where: { status: 'CONFIRMED' },
        _sum: { amountPaid: true },
      }),
      this.prisma.groupSubscription.groupBy({
        by: ['tier'],
        _count: { id: true },
      }),
      this.prisma.groupSubscription.count({ where: { status: SubscriptionStatus.TRIAL } }),
      this.prisma.groupSubscription.count({ where: { status: SubscriptionStatus.SUSPENDED } }),
    ]);

    const thisMonthRevenue = totalThisMonth._sum.amountPaid ?? 0;
    const lastMonthRevenue = totalLastMonth._sum.amountPaid ?? 0;
    const momGrowth =
      lastMonthRevenue > 0
        ? (((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100).toFixed(2)
        : null;

    // Revenue breakdown by tier — join subscription payments with their subscription tier
    const tierRevenue = await this.prisma.$queryRaw<{ tier: string; total: number }[]>`
      SELECT gs.tier, SUM(sp."amountPaid") as total
      FROM "SubscriptionPayment" sp
      JOIN "GroupSubscription" gs ON sp."subscriptionId" = gs.id
      WHERE sp.status = 'CONFIRMED'
      GROUP BY gs.tier
    `;

    return {
      totalAllTime: totalAllTime._sum.amountPaid ?? 0,
      totalThisMonth: thisMonthRevenue,
      momGrowthPercent: momGrowth,
      revenueByTier: tierRevenue,
      groupsPerTier,
      trialGroupCount: trialCount,
      suspendedGroupCount: suspendedCount,
    };
  }

  async searchUsers(dto: SearchUserDto) {
    return this.prisma.user.findMany({
      where: {
        OR: [
          { fullName: { contains: dto.query, mode: 'insensitive' } },
          { phoneNumber: { contains: dto.query } },
          { nationalId: { contains: dto.query } },
        ],
      },
      select: {
        id: true,
        fullName: true,
        phoneNumber: true,
        nationalId: true,
        roles: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  async sendPlatformAnnouncement(dto: PlatformAnnouncementDto) {
    const users = await this.prisma.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    await Promise.all(
      users.map((u) =>
        this.notifications.sendNotification(
          u.id,
          NotificationType.WEEKLY_REMINDER, // reuse generic type for platform-wide
          dto.message,
          NotificationChannel.PUSH,
        ),
      ),
    );

    return { message: `Announcement sent to ${users.length} users` };
  }

  async getAllSubscriptions() {
    return this.prisma.groupSubscription.findMany({
      include: {
        group: { select: { name: true, isSuspended: true } },
        payments: { take: 1, orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async overrideSubscription(groupId: string, dto: OverrideSubscriptionDto, adminId: string) {
    const sub = await this.prisma.groupSubscription.findFirst({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    await this.prisma.groupSubscription.update({
      where: { id: sub.id },
      data: { status: SubscriptionStatus.ACTIVE, lastPaidAt: new Date() },
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

    await this.prisma.auditLog.create({
      data: {
        actorId: adminId,
        actionType: 'SUBSCRIPTION_OVERRIDE',
        targetId: groupId,
        metadata: { reason: dto.reason },
      },
    });

    return { message: 'Subscription manually activated' };
  }
}
