import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';
import { DisputeStatus, Role } from '@prisma/client';

@Injectable()
export class DisputesService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateDisputeDto) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: dto.groupId, userId } }
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException('Must be an active member to raise a dispute');
    }

    return this.prisma.dispute.create({
      data: {
        groupId: dto.groupId,
        raiserId: userId,
        weekNumber: dto.weekNumber,
        claimDescription: dto.claimDescription,
        momoReference: dto.momoReference,
      }
    });
  }

  async getGroupDisputes(groupId: string, userId: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.dispute.findMany({
      where: { groupId },
      include: { raiser: { select: { fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  async resolve(id: string, userId: string, dto: ResolveDisputeDto) {
    const dispute = await this.prisma.dispute.findUnique({ where: { id } });
    if (!dispute) throw new NotFoundException('Dispute not found');

    await this.ensureTreasurer(dispute.groupId, userId);

    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException('Can only resolve OPEN disputes');
    }

    return this.prisma.dispute.update({
      where: { id },
      data: { status: DisputeStatus.RESOLVED, resolutionNote: dto.resolutionNote }
    });
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
      data: { status: DisputeStatus.ESCALATED }
    });
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
