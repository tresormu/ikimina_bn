import { Injectable, BadRequestException, UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterLenderDto, LoginLenderDto, SearchMemberDto, UpdateLenderProfileDto, FlagReportDto } from './dto/lender.dto';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LendersService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterLenderDto) {
    const existing = await this.prisma.lender.findUnique({ where: { email: dto.email } });
    if (existing) throw new BadRequestException('Email already in use');

    const hashedPassword = await bcrypt.hash(dto.password, 10);

    const lender = await this.prisma.lender.create({
      data: {
        institutionName: dto.institutionName,
        licenseNumber: dto.licenseNumber,
        email: dto.email,
        password: hashedPassword,
        isApproved: false,
      }
    });

    return { message: 'Registration successful, pending admin approval', lenderId: lender.id };
  }

  async getStatus(lenderId: string) {
    const lender = await this.prisma.lender.findUnique({ where: { id: lenderId } });
    if (!lender) throw new NotFoundException('Lender not found');
    return { isApproved: lender.isApproved, isSuspended: lender.isSuspended };
  }

  async login(dto: LoginLenderDto) {
    const lender = await this.prisma.lender.findUnique({ where: { email: dto.email } });
    if (!lender) throw new UnauthorizedException('Invalid credentials');

    const isValid = await bcrypt.compare(dto.password, lender.password);
    if (!isValid) throw new UnauthorizedException('Invalid credentials');

    if (lender.isSuspended) throw new ForbiddenException('Account suspended');
    if (!lender.isApproved) throw new ForbiddenException('Account pending approval');

    const payload = { sub: lender.id, role: 'LENDER' };
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get('JWT_ACCESS_SECRET'),
      expiresIn: '1h'
    });

    return { accessToken };
  }

  async updateProfile(lenderId: string, dto: UpdateLenderProfileDto) {
    const lender = await this.prisma.lender.findUnique({ where: { id: lenderId } });
    if (!lender) throw new NotFoundException('Lender not found');

    const data: any = {};
    if (dto.institutionName) data.institutionName = dto.institutionName;
    if (dto.email) data.email = dto.email;
    if (dto.password) data.password = await bcrypt.hash(dto.password, 10);

    return this.prisma.lender.update({
      where: { id: lenderId },
      data,
      select: { id: true, institutionName: true, email: true, isApproved: true },
    });
  }

  async getReportAccessLog(lenderId: string) {
    const lender = await this.prisma.lender.findUnique({ where: { id: lenderId } });
    if (!lender?.isApproved || lender.isSuspended) throw new ForbiddenException('Unauthorized');

    // Return shared report access logs where the lender accessed them
    // In this model, lenders access via shared links — log is in SharedReportAccessLog
    return this.prisma.sharedReportAccessLog.findMany({
      orderBy: { accessedAt: 'desc' },
      include: {
        sharedReport: {
          include: { user: { select: { fullName: true } } },
        },
      },
      take: 50,
    });
  }

  async flagReport(lenderId: string, reportId: string, dto: FlagReportDto) {
    const lender = await this.prisma.lender.findUnique({ where: { id: lenderId } });
    if (!lender?.isApproved || lender.isSuspended) throw new ForbiddenException('Unauthorized');

    const report = await this.prisma.sharedCreditReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    await this.prisma.auditLog.create({
      data: {
        actionType: 'REPORT_FLAGGED',
        targetId: reportId,
        metadata: { flaggedBy: lenderId, reason: dto.reason },
      },
    });

    return { message: 'Report flagged for review' };
  }

  async searchMember(lenderId: string, dto: SearchMemberDto) {
    const lender = await this.prisma.lender.findUnique({ where: { id: lenderId } });
    if (!lender?.isApproved || lender.isSuspended) throw new ForbiddenException('Unauthorized access');

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phoneNumber: dto.query },
          { nationalId: dto.query }
        ]
      },
      include: {
        groupMembers: {
          include: {
             group: {
                 include: { subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 } }
             }
          }
        }
      }
    });

    if (!user) throw new NotFoundException('User not found');

    // Verification: user must be in at least one active group (paid subscription)
    const isInActiveGroup = user.groupMembers.some(m => {
        const sub = m.group.subscriptions[0];
        return m.isActive && sub && (sub.status === 'ACTIVE' || sub.status === 'TRIAL');
    });

    if (!isInActiveGroup) {
      throw new ForbiddenException('User is not part of any group with an active subscription. Credit report unavailable.');
    }

    const score = await this.prisma.creditScore.findUnique({ where: { userId: user.id } });

    // Under new monetization, lenders get FREE access to the full report 
    // IF the user is in an active group (which we just checked).
    return {
      profile: { fullName: user.fullName, nationalId: user.nationalId },
      score: score ? { score: score.score, label: score.label } : null,
      message: 'Full report access granted via group subscription.'
    };
  }
}
