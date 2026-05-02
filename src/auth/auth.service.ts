import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { SendOtpDto } from './dto/send-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  private generateNumericOtp(length: number): string {
    let otp = '';
    for (let i = 0; i < length; i++) {
      otp += Math.floor(Math.random() * 10).toString();
    }
    return otp;
  }

  async sendOtp(dto: SendOtpDto) {
    // 1. Rate Limiting Check (3 requests per phone per hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentRequests = await this.prisma.otpRecord.count({
      where: {
        phoneNumber: dto.phoneNumber,
        createdAt: { gte: oneHourAgo },
      },
    });

    if (recentRequests >= 3) {
      throw new BadRequestException({
        errorCode: 'RATE_LIMIT_EXCEEDED',
        message: 'Maximum OTP requests exceeded for this hour',
      });
    }

    // 2. Generate OTP
    const rawOtp = this.generateNumericOtp(6);
    const hashedOtp = await bcrypt.hash(rawOtp, 10);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // 3. Save to DB
    await this.prisma.otpRecord.create({
      data: {
        phoneNumber: dto.phoneNumber,
        hashedOtp,
        expiresAt,
      },
    });

    // 4. Mock sending SMS via Africa's Talking
    console.log(`[MOCK SMS] To: ${dto.phoneNumber} - Your IkiminaPass OTP is ${rawOtp}`);

    return { message: 'OTP sent successfully' };
  }

  async verifyOtp(dto: VerifyOtpDto) {
    // 1. Find latest OTP record for this phone
    const record = await this.prisma.otpRecord.findFirst({
      where: { phoneNumber: dto.phoneNumber },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException({ errorCode: 'INVALID_OTP', message: 'No OTP found' });
    }

    if (record.expiresAt < new Date()) {
      throw new BadRequestException({ errorCode: 'OTP_EXPIRED', message: 'OTP has expired' });
    }

    const isValid = await bcrypt.compare(dto.otp, record.hashedOtp);
    if (!isValid) {
      throw new BadRequestException({ errorCode: 'INVALID_OTP', message: 'Invalid OTP' });
    }

    // 2. Clear used OTPs
    await this.prisma.otpRecord.deleteMany({
      where: { phoneNumber: dto.phoneNumber },
    });

    // 3. Find or Create User
    let user = await this.prisma.user.findUnique({
      where: { phoneNumber: dto.phoneNumber },
    });

    let isNewUser = false;
    if (!user) {
      user = await this.prisma.user.create({
        data: { phoneNumber: dto.phoneNumber },
      });
      isNewUser = true;
    }

    return this.generateTokens(user.id, isNewUser);
  }

  async refreshToken(dto: RefreshTokenDto) {
    const record = await this.prisma.refreshToken.findUnique({
      where: { token: dto.refreshToken },
      include: { user: true },
    });

    if (!record || record.revoked || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (!record.user.isActive) {
      throw new UnauthorizedException('User is inactive');
    }

    // Revoke old token
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revoked: true },
    });

    return this.generateTokens(record.userId, false);
  }

  async logout(userId: string, refreshToken: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, token: refreshToken },
      data: { revoked: true },
    });
    return { message: 'Logged out successfully' };
  }

  private async generateTokens(userId: string, isNewUser: boolean) {
    const payload = { sub: userId };
    
    const accessToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: (this.configService.get<string>('JWT_ACCESS_EXPIRES_IN') ?? '15m') as any,
    });

    const refreshToken = this.jwtService.sign(payload, {
      secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ?? '7d') as any,
    });

    // Save refresh token to DB
    const decodedRefresh = this.jwtService.decode(refreshToken) as any;
    const expiresAt = new Date(decodedRefresh.exp * 1000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        token: refreshToken,
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      isNewUser,
    };
  }
}
