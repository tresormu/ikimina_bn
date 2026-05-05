import { Controller, Get, Patch, Post, Param, Body, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';
import type { User } from '@prisma/client';
import {
  SuspendGroupDto,
  ResolveDisputeAdminDto,
  PlatformAnnouncementDto,
  SearchUserDto,
  OverrideSubscriptionDto,
} from './dto/admin.dto';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('groups')
  @ApiOperation({ summary: 'List all groups with activity status' })
  getAllGroups() {
    return this.adminService.getAllGroups();
  }

  @Patch('groups/:id/suspend')
  @ApiOperation({ summary: 'Suspend a group with reason' })
  suspendGroup(@Param('id') id: string, @Body() dto: SuspendGroupDto) {
    return this.adminService.suspendGroup(id, dto);
  }

  @Get('disputes')
  @ApiOperation({ summary: 'All disputes escalated to admin level' })
  getAllDisputes() {
    return this.adminService.getAllDisputes();
  }

  @Patch('disputes/:id/resolve')
  @ApiOperation({ summary: 'Resolve an escalated dispute' })
  resolveDispute(
    @Param('id') id: string,
    @Body() dto: ResolveDisputeAdminDto,
    @CurrentUser() user: User,
  ) {
    return this.adminService.resolveDispute(id, dto, user.id);
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Platform revenue breakdown' })
  getRevenue() {
    return this.adminService.getRevenue();
  }

  @Get('users/search')
  @ApiOperation({ summary: 'Search any user by name, phone, or national ID' })
  searchUsers(@Body() dto: SearchUserDto) {
    return this.adminService.searchUsers(dto);
  }

  @Post('announcement')
  @ApiOperation({ summary: 'Send platform-wide announcement to all users' })
  sendAnnouncement(@Body() dto: PlatformAnnouncementDto) {
    return this.adminService.sendPlatformAnnouncement(dto);
  }

  @Get('subscriptions')
  @ApiOperation({ summary: 'List all group subscriptions with status and tier' })
  getAllSubscriptions() {
    return this.adminService.getAllSubscriptions();
  }

  @Patch('subscriptions/:groupId/override')
  @ApiOperation({ summary: 'Manually mark a subscription as active' })
  overrideSubscription(
    @Param('groupId') groupId: string,
    @Body() dto: OverrideSubscriptionDto,
    @CurrentUser() user: User,
  ) {
    return this.adminService.overrideSubscription(groupId, dto, user.id);
  }
}
