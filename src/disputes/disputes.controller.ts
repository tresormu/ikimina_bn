import { Controller, Get, Post, Body, Patch, Param, UseGuards } from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { CreateDisputeDto, ResolveDisputeDto } from './dto/dispute.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Disputes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @ApiOperation({ summary: 'Member raises a new dispute' })
  create(@CurrentUser() user: User, @Body() dto: CreateDisputeDto) {
    return this.disputesService.create(user.id, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'View own disputes' })
  getMyDisputes(@CurrentUser() user: User) {
    return this.disputesService.getMyDisputes(user.id);
  }

  @Get('group/:groupId')
  @ApiOperation({ summary: 'Treasurer views all disputes in group' })
  getGroupDisputes(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.disputesService.getGroupDisputes(groupId, user.id);
  }

  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Treasurer marks dispute as resolved' })
  resolve(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: ResolveDisputeDto) {
    return this.disputesService.resolve(id, user.id, dto);
  }

  @Patch(':id/escalate')
  @ApiOperation({ summary: 'Treasurer escalates dispute to admin' })
  escalate(@Param('id') id: string, @CurrentUser() user: User) {
    return this.disputesService.escalate(id, user.id);
  }
}
