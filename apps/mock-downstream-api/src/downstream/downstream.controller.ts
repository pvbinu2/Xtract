import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DownstreamService } from './downstream.service';

@Controller()
export class DownstreamController {
  constructor(private readonly downstreamService: DownstreamService) {}

  @Post('documents')
  async receiveDocument(@Body() payload: Record<string, unknown>) {
    const stored = await this.downstreamService.storeRequest(payload);
    return { success: true, id: stored._id };
  }

  @Post('api/docling/extract')
  @UseInterceptors(FileInterceptor('file'))
  async extractMarkdown(@UploadedFile() file: any, @Body() body: { serviceUrl?: string }) {
    if (!file) {
      return { success: false, error: 'PDF file is required.' };
    }

    const serviceUrl = body.serviceUrl || process.env.DOCLING_MARKDOWN_SERVICE_URL || 'http://127.0.0.1:7072/api/extract-markdown';
    const response = await fetch(serviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.originalname || 'document.pdf',
        fileBase64: file.buffer.toString('base64'),
      }),
    });
    const responseText = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = { error: responseText };
    }

    if (!response.ok) {
      return {
        success: false,
        status: response.status,
        error: payload.error || response.statusText,
      };
    }

    return {
      success: true,
      serviceUrl,
      fileName: file.originalname,
      markdown: payload.markdown || payload.text || '',
      payload,
    };
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
