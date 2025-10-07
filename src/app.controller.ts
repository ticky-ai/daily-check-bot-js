import { Controller, Get, Post, Body, Logger } from '@nestjs/common';
import { AppService } from './app.service';
import { PaymentService } from './services/payment.service';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    private readonly paymentService: PaymentService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('webhook/yookassa')
  async handleYookassaWebhook(@Body() body: any) {
    try {
      this.logger.log(
        'Received YooKassa webhook:',
        JSON.stringify(body, null, 2),
      );

      if (
        body.event === 'payment.succeeded' ||
        body.event === 'payment.canceled'
      ) {
        await this.paymentService.handlePaymentWebhook(body);
      }

      return { status: 'ok' };
    } catch (error) {
      this.logger.error('Error handling YooKassa webhook:', error);
      return { status: 'error' };
    }
  }
}
