import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitContributionDto } from './dto/submit-contribution.dto';
import { ContributionStatus } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class ContributionsService {
  private readonly logger = new Logger(ContributionsService.name);

  constructor(private prisma: PrismaService) {}

  async getCurrentOwed(groupId: string, userId: string) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      include: {
        rotationLogs: { orderBy: { createdAt: 'desc' }, take: 1 },
      }
    });

    if (!group) throw new NotFoundException('Group not found');

    // Basic mock logic to calculate "current week"
    // In reality, this depends on group creation date and frequency
    const currentWeek = 1; 

    // Find who gets the pot this week
    const lastRotation = group.rotationLogs[0];
    const orderArray = lastRotation ? lastRotation.newOrder as string[] : [];
    const recipientId = orderArray[(currentWeek - 1) % orderArray.length];

    let recipientDetails: { name: string | null; phone: string } | null = null;
    if (recipientId) {
       const user = await this.prisma.user.findUnique({ where: { id: recipientId }});
       if (user) {
         recipientDetails = { name: user.fullName, phone: user.phoneNumber };
       }
    }

    const contribution = await this.prisma.contribution.findFirst({
      where: { groupId, userId, weekNumber: currentWeek }
    });

    return {
      amountOwed: group.contributionAmount,
      weekNumber: currentWeek,
      recipient: recipientDetails,
      paymentStatus: contribution ? contribution.status : ContributionStatus.PENDING,
      contributionId: contribution?.id
    };
  }

  async submit(groupId: string, userId: string, dto: SubmitContributionDto) {
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new NotFoundException('Group not found');
    if (group.isSuspended) throw new BadRequestException('Group is suspended. Contributions are not accepted.');

    // Determine current week
    const currentWeek = 1;

    // Mock verification with MTN MoMo
    this.logger.log(`Verifying MoMo TX ${dto.momoTransactionId} for User ${userId}`);
    
    // Simulate validation rules
    const isValid = dto.momoTransactionId.length > 5; // Simple mock rule
    
    const status = isValid ? ContributionStatus.CONFIRMED : ContributionStatus.FAILED;
    const failureReason = isValid ? null : 'Transaction not found or amount mismatch';

    const contribution = await this.prisma.contribution.create({
      data: {
        groupId,
        userId,
        weekNumber: currentWeek,
        amount: 0, // Should be fetched from group.contributionAmount
        status,
        momoTransactionId: dto.momoTransactionId,
        failureReason,
      }
    });

    // TODO: Trigger notifications
    // TODO: Trigger credit score recalculation if confirmed

    if (!isValid) {
      throw new BadRequestException({ message: 'Transaction validation failed', reason: failureReason });
    }

    return { message: 'Contribution confirmed', contribution };
  }

  async resubmit(contributionId: string, userId: string, dto: SubmitContributionDto) {
    const contribution = await this.prisma.contribution.findUnique({ where: { id: contributionId } });
    
    if (!contribution || contribution.userId !== userId) {
      throw new NotFoundException('Contribution not found');
    }

    if (contribution.status === ContributionStatus.CONFIRMED) {
      throw new BadRequestException('Contribution already confirmed');
    }

    // Mock validation again
    const isValid = dto.momoTransactionId.length > 5;
    const status = isValid ? ContributionStatus.CONFIRMED : ContributionStatus.FAILED;
    const failureReason = isValid ? null : 'Transaction not found or amount mismatch';

    const updated = await this.prisma.contribution.update({
      where: { id: contributionId },
      data: {
        status,
        momoTransactionId: dto.momoTransactionId,
        failureReason
      }
    });

    if (!isValid) {
      throw new BadRequestException({ message: 'Transaction validation failed', reason: failureReason });
    }

    return { message: 'Contribution resubmitted and confirmed', contribution: updated };
  }

  async getMyHistory(userId: string) {
    return this.prisma.contribution.findMany({
      where: { userId },
      include: { group: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getGroupHistory(groupId: string) {
    return this.prisma.contribution.findMany({
      where: { groupId },
      include: { user: { select: { fullName: true, phoneNumber: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  @Cron('0 23 * * 0') // Example: Every Sunday at 11 PM
  async checkMissedContributions() {
    this.logger.log('Checking for missed contributions...');
    // Logic to find pending contributions past deadline, mark as MISSED, notify users.
  }
}
