import { Body, Controller, Get, HttpException, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { DemoRequestsService } from './demo-requests.service';
import { Public, Roles } from '../auth/auth.decorators';

@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly service: DemoRequestsService) {}

  @Public()
  @Post()
  async create(
    @Body() body: { email?: string; phone?: string; turnstileToken?: string; website?: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      return await this.service.create(body, request.ip || request.socket.remoteAddress || 'unknown');
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) response.setHeader('Retry-After', '600');
      throw error;
    }
  }

  @Public()
  @Get('settings')
  settings() {
    return this.service.publicSettings();
  }

  @Roles('admin')
  @Get()
  list() {
    return this.service.list();
  }
}
