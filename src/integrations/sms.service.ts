import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  /**
   * Mock implementation of Africa's Talking SMS
   */
  async sendSms(phoneNumber: string, message: string): Promise<boolean> {
    this.logger.log(`[AfricasTalking Mock] Sending SMS to ${phoneNumber}: ${message}`);
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 300));
    return true;
  }
}
