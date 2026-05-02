import { Module } from '@nestjs/common';
import { CreditScoreController } from './credit-score.controller';
import { CreditScoreService } from './credit-score.service';

@Module({
  controllers: [CreditScoreController],
  providers: [CreditScoreService]
})
export class CreditScoreModule {}
