import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { GroupsModule } from './groups/groups.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ContributionsModule } from './contributions/contributions.module';
import { CreditScoreModule } from './credit-score/credit-score.module';
import { LoansModule } from './loans/loans.module';
import { UssdModule } from './ussd/ussd.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LendersModule } from './lenders/lenders.module';
import { DisputesModule } from './disputes/disputes.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100, // 100 requests per minute globally
    }]),
    PrismaModule,
    AuthModule,
    UsersModule,
    GroupsModule,
    SubscriptionsModule,
    ContributionsModule,
    CreditScoreModule,
    LoansModule,
    UssdModule,
    NotificationsModule,
    LendersModule,
    DisputesModule,
    AdminModule,
  ],
})
export class AppModule {}
