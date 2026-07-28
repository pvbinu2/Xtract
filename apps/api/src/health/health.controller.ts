import { Controller, Get } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Roles('admin')
  check() {
    return this.healthService.checkAll();
  }
}
