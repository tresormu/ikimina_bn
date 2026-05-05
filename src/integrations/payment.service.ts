import { Injectable, Logger } from '@nestjs/common';

export enum PaymentProvider {
  MTN_MOMO = 'MTN_MOMO',
  AIRTEL_MONEY = 'AIRTEL_MONEY'
}

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  /**
   * Mock implementation of Mobile Money Payment Request
   */
  async requestPayment(phoneNumber: string, amount: number, provider: PaymentProvider): Promise<{ transactionId: string, status: string }> {
    this.logger.log(`[${provider} Mock] Requesting payment of ${amount} RWF from ${phoneNumber}`);
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Return a mock transaction ID
    return {
      transactionId: `MOCK_TX_${Math.floor(Math.random() * 1000000)}`,
      status: 'PENDING'
    };
  }

  /**
   * Mock implementation of Mobile Money Transaction Verification
   */
  async verifyTransaction(transactionId: string): Promise<{ status: string, amount: number }> {
    this.logger.log(`[MoMo Verification Mock] Verifying TxID: ${transactionId}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Mock always returns success for testing purposes
    return {
      status: 'SUCCESSFUL',
      amount: 5000 // In a real scenario, this would be the actual amount from the provider
    };
  }
}
