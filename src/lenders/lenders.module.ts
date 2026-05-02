import { Module } from '@nestjs/common';
import { LendersController } from './lenders.controller';
import { LendersService } from './lenders.service';

@Module({
  controllers: [LendersController],
  providers: [LendersService]
})
export class LendersModule {}
