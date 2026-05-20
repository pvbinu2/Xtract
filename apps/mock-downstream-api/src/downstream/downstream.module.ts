import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DownstreamRequest, DownstreamRequestSchema } from '../schemas/downstream-request.schema';
import { DownstreamController } from './downstream.controller';
import { DownstreamService } from './downstream.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: DownstreamRequest.name, schema: DownstreamRequestSchema }])],
  controllers: [DownstreamController],
  providers: [DownstreamService],
})
export class DownstreamModule {}
