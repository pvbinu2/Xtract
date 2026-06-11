import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DemoRequest, DemoRequestSchema } from '../schemas/demo-request.schema';
import { DemoRequestsController } from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: DemoRequest.name, schema: DemoRequestSchema }])],
  controllers: [DemoRequestsController],
  providers: [DemoRequestsService],
})
export class DemoRequestsModule {}
