import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './subscriptions/users/users.module';
import { GroupsModule } from './groups/groups.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ContributionsModule } from './contributions/contributions.module';
import { CreditScoreModule } from './credit-score/credit-score.module';
import { LoansModule } from './loans/loans.module';
import { UssdModule } from './ussd/ussd.module';
import { NotificationsModule } from './notifications/notifications.module';
import { DisputesModule } from './disputes/disputes.module';
import { AdminModule } from './admin/admin.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AuctionModule } from './auction/auction.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 100,
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
    DisputesModule,
    AdminModule,
    IntegrationsModule,
    AuctionModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
