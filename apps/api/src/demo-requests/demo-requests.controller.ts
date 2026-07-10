import { Body, Controller, Get, Post } from '@nestjs/common';
import { DemoRequestsService } from './demo-requests.service';
import { Public, Roles } from '../auth/auth.decorators';

@Controller('demo-requests')
export class DemoRequestsController {
  constructor(private readonly service: DemoRequestsService) {}

  @Public()
  @Post()
  create(@Body() body: { email?: string; phone?: string; source?: string }) {
    return this.service.create(body);
  }

  @Roles('admin')
  @Get()
  list() {
    return this.service.list();
  }
}
