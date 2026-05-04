import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { LoansService } from './loans.service';
import { RequestLoanDto } from './dto/request-loan.dto';
import { DecideLoanDto } from './dto/decide-loan.dto';
import { RepayLoanDto } from './dto/repay-loan.dto';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '@prisma/client';

@ApiTags('Loans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Post('request')
  @ApiOperation({ summary: 'Submit a loan request' })
  requestLoan(@CurrentUser() user: User, @Body() dto: RequestLoanDto) {
    return this.loansService.requestLoan(user.id, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'View own loan requests' })
  getMyLoans(@CurrentUser() user: User) {
    return this.loansService.getMyLoans(user.id);
  }

  @Get('group/:groupId')
  @ApiOperation({ summary: 'Treasurer views all loans in group' })
  getGroupLoans(@Param('groupId') groupId: string, @CurrentUser() user: User) {
    return this.loansService.getGroupLoans(groupId, user.id);
  }

  @Post(':loanId/decision')
  @ApiOperation({ summary: 'Treasurer approves or declines a pending loan request' })
  decideLoan(@Param('loanId') loanId: string, @CurrentUser() user: User, @Body() dto: DecideLoanDto) {
    return this.loansService.decideLoan(loanId, user.id, dto);
  }

  @Post(':loanId/repay')
  @ApiOperation({ summary: 'Treasurer records a repayment' })
  repay(@Param('loanId') loanId: string, @CurrentUser() user: User, @Body() dto: RepayLoanDto) {
    return this.loansService.repay(loanId, user.id, dto);
  }
}
