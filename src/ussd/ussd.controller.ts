import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { UssdService } from './ussd.service';
import { UssdRequestDto } from './dto/ussd-request.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('USSD')
@Controller('ussd')
export class UssdController {
  constructor(private readonly ussdService: UssdService) {}

  @Public()
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Africas Talking USSD Webhook' })
  handleUssd(@Body() dto: UssdRequestDto) {
    return this.ussdService.handleUssd(dto);
  }
}
