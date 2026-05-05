import { Module, Global } from '@nestjs/common';
import { SmsService } from './sms.service';
import { PaymentService } from './payment.service';

@Global()
@Module({
  providers: [SmsService, PaymentService],
  exports: [SmsService, PaymentService],
})
export class IntegrationsModule {}
