import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DemoRequest, DemoRequestSchema } from '../schemas/demo-request.schema';
import { DemoRequestsController } from './demo-requests.controller';
import { DemoRequestsService } from './demo-requests.service';
import { ConfigurationModule } from '../configuration/configuration.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: DemoRequest.name, schema: DemoRequestSchema }]),
    ConfigurationModule,
  ],
  controllers: [DemoRequestsController],
  providers: [DemoRequestsService],
})
export class DemoRequestsModule {}
