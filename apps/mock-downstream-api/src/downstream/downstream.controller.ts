import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { DownstreamService } from './downstream.service';

@Controller()
export class DownstreamController {
  constructor(private readonly downstreamService: DownstreamService) {}

  @Post('documents')
  async receiveDocument(@Body() payload: Record<string, unknown>) {
    const stored = await this.downstreamService.storeRequest(payload);
    return { success: true, id: stored._id };
  }

  @Get('api/requests')
  async getRequests() {
    const requests = await this.downstreamService.getRequests();
    const count = await this.downstreamService.count();
    return { requests, count };
  }

  @Get('api/requests/:id')
  async getRequest(@Param('id') id: string) {
    const request = await this.downstreamService.getRequest(id);
    return request;
  }

  @Delete('api/requests/:id')
  async deleteRequest(@Param('id') id: string) {
    await this.downstreamService.deleteRequest(id);
    return { success: true };
  }

  @Post('api/requests/clear')
  async clearAll() {
    await this.downstreamService.clearAll();
    return { success: true };
  }
}
