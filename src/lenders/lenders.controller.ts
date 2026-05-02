import { Controller, Get, Post, Patch, Param, Body, UseGuards, Req } from '@nestjs/common';
import { LendersService } from './lenders.service';
import { RegisterLenderDto, LoginLenderDto, SearchMemberDto, UpdateLenderProfileDto, FlagReportDto } from './dto/lender.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Lenders')
@Controller('lenders')
export class LendersController {
  constructor(private readonly lendersService: LendersService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new lending institution' })
  register(@Body() dto: RegisterLenderDto) {
    return this.lendersService.register(dto);
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Lender login' })
  login(@Body() dto: LoginLenderDto) {
    return this.lendersService.login(dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('status')
  @ApiOperation({ summary: 'Check approval status' })
  getStatus(@Req() req: any) {
    // Note: Lender uses same JwtAuthGuard, payload has sub=lenderId
    return this.lendersService.getStatus(req.user.id || req.user.sub);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  @ApiOperation({ summary: 'Update lender contact details and password' })
  updateProfile(@Req() req: any, @Body() dto: UpdateLenderProfileDto) {
    return this.lendersService.updateProfile(req.user.id || req.user.sub, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('reports')
  @ApiOperation({ summary: 'Report access log' })
  getReports(@Req() req: any) {
    return this.lendersService.getReportAccessLog(req.user.id || req.user.sub);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('reports/:reportId/flag')
  @ApiOperation({ summary: 'Flag a report as potentially fraudulent' })
  flagReport(@Req() req: any, @Param('reportId') reportId: string, @Body() dto: FlagReportDto) {
    return this.lendersService.flagReport(req.user.id || req.user.sub, reportId, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('search')
  @ApiOperation({ summary: 'Search member by phone or National ID' })
  searchMember(@Req() req: any, @Body() dto: SearchMemberDto) {
    return this.lendersService.searchMember(req.user.id || req.user.sub, dto);
  }
}
