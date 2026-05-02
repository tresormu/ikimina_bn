import { Controller, Get, Post, Body, Patch, Param, UseGuards } from '@nestjs/common';
import { GroupsService } from './groups.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { UpdateRotationDto } from './dto/update-rotation.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { User } from '@prisma/client';

@ApiTags('Groups')
@Controller('groups')
export class GroupsController {
  constructor(private readonly groupsService: GroupsService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post()
  @ApiOperation({ summary: 'Treasurer creates a new group' })
  createGroup(@CurrentUser() user: User, @Body() dto: CreateGroupDto) {
    return this.groupsService.createGroup(user.id, dto);
  }

  @Public()
  @Get('join/:inviteCode')
  @ApiOperation({ summary: 'Preview group details before joining' })
  previewGroup(@Param('inviteCode') inviteCode: string) {
    return this.groupsService.previewGroup(inviteCode);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('join')
  @ApiOperation({ summary: 'Join a group via invite code' })
  joinGroup(@CurrentUser() user: User, @Body('inviteCode') inviteCode: string) {
    return this.groupsService.joinGroup(user.id, inviteCode);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'List all groups the user belongs to' })
  getUserGroups(@CurrentUser() user: User) {
    return this.groupsService.getUserGroups(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get full group details' })
  getGroupDetails(@Param('id') id: string, @CurrentUser() user: User) {
    return this.groupsService.getGroupDetails(id, user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  @ApiOperation({ summary: 'Treasurer updates group settings' })
  updateGroup(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: UpdateGroupDto) {
    return this.groupsService.updateGroup(id, user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id/rotation')
  @ApiOperation({ summary: 'Treasurer reorders rotation' })
  updateRotation(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: UpdateRotationDto) {
    return this.groupsService.updateRotation(id, user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id/members/:memberId/deactivate')
  @ApiOperation({ summary: 'Treasurer marks member as inactive' })
  deactivateMember(
    @Param('id') groupId: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user: User
  ) {
    return this.groupsService.deactivateMember(groupId, memberId, user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get(':id/feed')
  @ApiOperation({ summary: 'Get recent group activity feed' })
  getFeed(@Param('id') id: string, @CurrentUser() user: User) {
    return this.groupsService.getFeed(id, user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':id/announcement')
  @ApiOperation({ summary: 'Treasurer posts an announcement' })
  postAnnouncement(@Param('id') id: string, @CurrentUser() user: User, @Body('message') message: string) {
    return this.groupsService.postAnnouncement(id, user.id, message);
  }
}
