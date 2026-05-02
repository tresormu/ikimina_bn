import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UssdRequestDto } from './dto/ussd-request.dto';

@Injectable()
export class UssdService {
  constructor(private prisma: PrismaService) {}

  async handleUssd(dto: UssdRequestDto) {
    const { sessionId, phoneNumber, text } = dto;
    
    let response = '';

    // Find User
    const user = await this.prisma.user.findUnique({ where: { phoneNumber } });

    if (!user) {
      return `END Welcome to IkiminaPass. Please register via our mobile app first.`;
    }

    if (text === '') {
      // Main Menu
      response = `CON Welcome to IkiminaPass
1. Check contribution status
2. View credit score
3. Report a problem
4. Contact treasurer`;
    } else if (text === '1') {
      response = `END Your next contribution is 5000 RWF due this Friday. Status: PENDING.`;
    } else if (text === '2') {
      const score = await this.prisma.creditScore.findUnique({ where: { userId: user.id } });
      if (score) {
        response = `END Your credit score is ${score.score} (${score.label}).`;
      } else {
        response = `END You do not have a credit score yet.`;
      }
    } else if (text === '3') {
      // Store complaint as an audit log entry and notify admin
      await this.prisma.auditLog.create({
        data: {
          actorId: user.id,
          actionType: 'USSD_COMPLAINT',
          metadata: { phoneNumber, sessionId, message: 'User reported a problem via USSD' },
        },
      });
      response = `END Your complaint has been recorded. Our team will contact you shortly.`;
    } else if (text === '4') {
      response = `END Treasurer: John Doe, 0788123456.`;
    } else {
      response = `END Invalid option. Please try again.`;
    }

    // Save/Update session
    await this.prisma.ussdSession.upsert({
      where: { sessionId },
      update: { data: { lastText: text } },
      create: { sessionId, userId: user.id, state: 'OPEN', data: { lastText: text } }
    });

    return response;
  }
}
