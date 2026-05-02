import { Module } from '@nestjs/common';
import { ContributionsController } from './contributions.controller';
import { ContributionsService } from './contributions.service';

@Module({
  controllers: [ContributionsController],
  providers: [ContributionsService]
})
export class ContributionsModule {}
