import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phoneNumber: true,
        fullName: true,
        nationalId: true,
        profilePhotoUrl: true,
        roles: true,
        isActive: true,
        createdAt: true,
      },
    });
    
    if (!user || !user.isActive) {
        throw new NotFoundException('User not found');
    }
    return user;
  }

  async updateProfile(userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: {
        id: true,
        phoneNumber: true,
        fullName: true,
        nationalId: true,
        profilePhotoUrl: true,
      },
    });
    return user;
  }

  async softDelete(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isActive: false,
        deletedAt: new Date(),
      },
    });
    return { message: 'Account deleted successfully' };
  }

  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        groupMembers: {
          include: { group: true }
        }
      }
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }
}
