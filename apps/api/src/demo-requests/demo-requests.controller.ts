import { Body, Controller, Get, Post } from '@nestjs/common';
import { DemoRequestsService } from './demo-requests.service';

@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly service: DemoRequestsService) {}

  @Post()
  create(@Body() body: { email?: string; phone?: string; source?: string }) {
    return this.service.create(body);
  }

  @Get()
  list() {
    return this.service.list();
  }
}
