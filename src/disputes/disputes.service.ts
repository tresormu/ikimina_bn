import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';
import { DisputeStatus, Role, NotificationType, NotificationChannel } from '@prisma/client';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  async create(userId: string, dto: CreateDisputeDto) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: dto.groupId, userId } },
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException('Must be an active member to raise a dispute');
    }

    // Auto-resolve CONTRIBUTION_NOT_RECORDED if TxID exists in records
    if (dto.disputeType === 'CONTRIBUTION_NOT_RECORDED' && dto.momoReference) {
      const found = await this.prisma.contribution.findFirst({
        where: { momoTransactionId: dto.momoReference, userId, groupId: dto.groupId },
      });
      if (found) {
        return {
          autoResolved: true,
          message: 'Your contribution was found in the system. No dispute needed.',
          contribution: found,
        };
      }
    }

    const dispute = await this.prisma.dispute.create({
      data: {
        groupId: dto.groupId,
        raiserId: userId,
        weekNumber: dto.weekNumber,
        disputeType: dto.disputeType ?? 'CONTRIBUTION_NOT_RECORDED',
        claimDescription: dto.claimDescription,
        momoReference: dto.momoReference,
      },
    });

    // Notify treasurer immediately via SMS
    const treasurer = await this.prisma.groupMember.findFirst({
      where: { groupId: dto.groupId, role: Role.TREASURER, isActive: true },
    });
    if (treasurer) {
      const raiser = await this.prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
      await this.notifications.sendNotification(
        treasurer.userId,
        NotificationType.DISPUTE_OPENED,
        `URGENT: ${raiser?.fullName ?? 'A member'} filed a ${dispute.disputeType} dispute. Respond within 48 hours.`,
        NotificationChannel.SMS,
      );
    }

    // Pattern tracking: member with 3+ unresolved disputes in 90 days
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const recentUnresolved = await this.prisma.dispute.count({
      where: {
        raiserId: userId,
        status: { in: [DisputeStatus.OPEN, DisputeStatus.ESCALATED] },
        createdAt: { gte: ninetyDaysAgo },
      },
    });
    if (recentUnresolved >= 3) {
      this.logger.warn(`Member ${userId} has ${recentUnresolved} unresolved disputes in 90 days — flagged for review`);
      await this.prisma.auditLog.create({
        data: {
          actorId: userId,
          actionType: 'MEMBER_DISPUTE_PATTERN_FLAGGED',
          targetId: userId,
          metadata: { unresolvedCount: recentUnresolved, windowDays: 90 },
        },
      });
    }

    // Pattern tracking: treasurer with 2+ TREASURER_MISCONDUCT disputes
    if (dto.disputeType === 'TREASURER_MISCONDUCT' && treasurer) {
      const misconductCount = await this.prisma.dispute.count({
        where: {
          groupId: dto.groupId,
          disputeType: 'TREASURER_MISCONDUCT',
          status: { not: DisputeStatus.CLOSED },
        },
      });
      if (misconductCount >= 2) {
        this.logger.warn(`Treasurer ${treasurer.userId} has ${misconductCount} misconduct disputes — admin notified`);
        await this.prisma.auditLog.create({
          data: {
            actionType: 'TREASURER_MISCONDUCT_PATTERN',
            targetId: treasurer.userId,
            metadata: { groupId: dto.groupId, count: misconductCount },
          },
        });
      }
    }

    return dispute;
  }

  async getGroupDisputes(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.dispute.findMany({
      where: { groupId },
      include: { raiser: { select: { fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMyDisputes(userId: string) {
    return this.prisma.dispute.findMany({
      where: { raiserId: userId },
      include: { group: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async resolve(id: string, userId: string, dto: ResolveDisputeDto) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found');

    await this.ensureTreasurer(dispute.groupId, userId);

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException('Can only resolve OPEN disputes');
    }

    const updated = await this.prisma.dispute.update({
      where: { id },
      data: { status: DisputeStatus.RESOLVED, resolutionNote: dto.resolutionNote },
    });

    await this.notifications.sendNotification(
      dispute.raiserId,
      NotificationType.DISPUTE_RESOLVED,
      `Your dispute has been resolved. Note: ${dto.resolutionNote}`,
      NotificationChannel.SMS,
    );

    return updated;
  }

  async escalate(id: string, userId: string) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found');

    await this.ensureTreasurer(dispute.groupId, userId);

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException('Can only escalate OPEN disputes');
    }

    return this.prisma.dispute.update({
      where: { id },
      data: { status: DisputeStatus.ESCALATED },
    });
  }

  // Every hour — auto-escalate disputes unresolved for 72 hours
  // Uses cursor-based pagination to avoid OOM
  @Cron('0 * * * *')
  async autoEscalateStaleDisputes() {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000);
    let cursor: string | undefined;

    while (true) {
      const stale = await this.prisma.dispute.findMany({
        where: { status: DisputeStatus.OPEN, createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 500,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (stale.length === 0) break;

      // Bulk update the whole batch in one query
      await this.prisma.dispute.updateMany({
        where: { id: { in: stale.map((d) => d.id) } },
        data: { status: DisputeStatus.ESCALATED },
      });

      this.logger.log(`Auto-escalated ${stale.length} stale disputes`);

      cursor = stale[stale.length - 1].id;
      if (stale.length < 500) break;
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
