import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { UpdateRotationDto } from './dto/update-rotation.dto';
import { Role } from '@prisma/client';

@Injectable()
export class GroupsService {
  constructor(
    private prisma: PrismaService,
    private subscriptions: SubscriptionsService,
  ) {}

  private generateInviteCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  async createGroup(userId: string, dto: CreateGroupDto) {
    const inviteCode = this.generateInviteCode();
    
    // Create the group, make the creator a TREASURER, and add initial rotation order
    return this.prisma.$transaction(async (prisma) => {
      const group = await prisma.group.create({
        data: {
          name: dto.name,
          contributionAmount: dto.contributionAmount,
          frequency: dto.frequency,
          inviteCode,
          members: {
            create: {
              userId,
              role: Role.TREASURER,
            }
          }
        }
      });

      // Also create a subscription (Free Trial for 30 days)
      const trialEndsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const nextBillingDate = trialEndsAt;

      await prisma.groupSubscription.create({
        data: {
          groupId: group.id,
          tier: 'STARTER',
          memberCountAtBilling: 1,
          amountDue: 5000,
          billingDate: new Date(),
          status: 'TRIAL',
          trialEndsAt,
          nextBillingDate,
        }
      });

      // Save initial rotation log
      await prisma.rotationLog.create({
        data: {
          groupId: group.id,
          actorId: userId,
          previousOrder: [],
          newOrder: dto.initialRotationOrder,
        }
      });

      return group;
    });
  }

  async previewGroup(inviteCode: string) {
    const group = await this.prisma.group.findUnique({
      where: { inviteCode },
      select: {
        id: true,
        name: true,
        contributionAmount: true,
        frequency: true,
        _count: {
          select: { members: true }
        }
      }
    });

    if (!group) throw new NotFoundException('Invalid invite code');
    return group;
  }

  async joinGroup(userId: string, inviteCode: string) {
    const group = await this.prisma.group.findUnique({
      where: { inviteCode }
    });

    if (!group) throw new NotFoundException('Invalid invite code');
    if (group.isSuspended) throw new ForbiddenException('Group is currently suspended');

    const existingMember = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId } }
    });

    if (existingMember) {
      if (!existingMember.isActive) {
         // Reactivate member
         await this.prisma.groupMember.update({
             where: { id: existingMember.id },
             data: { isActive: true }
         });
         return { message: 'Rejoined group successfully' };
      }
      throw new BadRequestException('You are already a member of this group');
    }

    await this.prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId,
        role: Role.MEMBER,
      }
    });

    await this.subscriptions.recalculateTier(group.id);
    return { message: 'Joined group successfully' };
  }

  async getUserGroups(userId: string) {
    return this.prisma.group.findMany({
      where: {
        members: {
          some: { userId, isActive: true }
        }
      },
      include: {
        members: {
            where: { userId }
        }
      }
    });
  }

  async getGroupDetails(groupId: string, userId: string) {
    // Check if user is member
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });

    if (!membership || !membership.isActive) throw new ForbiddenException('Not a member');

    return this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: {
            include: { user: { select: { id: true, fullName: true, phoneNumber: true } } }
        },
        subscriptions: {
            take: 1,
            orderBy: { createdAt: 'desc' }
        }
      }
    });
  }

  async updateGroup(groupId: string, userId: string, dto: UpdateGroupDto) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.group.update({
      where: { id: groupId },
      data: dto
    });
  }

  async updateRotation(groupId: string, userId: string, dto: UpdateRotationDto) {
    await this.ensureTreasurer(groupId, userId);
    
    // Get last rotation
    const lastRotation = await this.prisma.rotationLog.findFirst({
        where: { groupId },
        orderBy: { createdAt: 'desc' }
    });

    return this.prisma.rotationLog.create({
      data: {
        groupId,
        actorId: userId,
        previousOrder: (lastRotation ? lastRotation.newOrder : []) as any,
        newOrder: dto.newOrder as any,
      }
    });
  }

  async deactivateMember(groupId: string, memberId: string, treasurerId: string) {
    await this.ensureTreasurer(groupId, treasurerId);
    
    const membership = await this.prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: memberId } }
    });

    if (!membership) throw new NotFoundException('Member not found in group');

    await this.prisma.groupMember.update({
      where: { id: membership.id },
      data: { isActive: false }
    });

    await this.subscriptions.recalculateTier(groupId);
    return { message: 'Member deactivated' };
  }

  async getFeed(groupId: string, userId: string) {
    await this.ensureMember(groupId, userId);
    return this.prisma.activityFeedEvent.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
  }

  async postAnnouncement(groupId: string, userId: string, message: string) {
    await this.ensureTreasurer(groupId, userId);
    return this.prisma.activityFeedEvent.create({
      data: {
        groupId,
        type: 'ANNOUNCEMENT',
        data: { message, postedBy: userId }
      }
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

  private async ensureMember(groupId: string, userId: string) {
    const membership = await this.prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId } }
    });
    if (!membership || !membership.isActive) {
      throw new ForbiddenException('Group member access required');
    }
  }
}
