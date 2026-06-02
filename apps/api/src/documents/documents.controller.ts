import { Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { DocumentsService } from './documents.service';

const storage = memoryStorage();

@Controller('documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  list(@Query() query: {
    status?: string;
    category?: string;
    name?: string;
    documentTypeId?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  }) {
    return this.service.list(query);
  }

  @Get('business-review/summary')
  businessReviewSummary() {
    return this.service.businessReviewSummary();
  }

  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', 50, { storage }))
  upload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { category?: string; documentTypeId?: string },
  ) {
    return this.service.upload(
      files.map((file) => ({
        fileName: file.originalname,
        originalName: file.originalname,
        buffer: file.buffer,
        mimeType: file.mimetype,
        category: body.category,
        documentTypeId: body.documentTypeId,
      })),
    );
  }

  @Get(':id')
  findById(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Get(':id/file')
  async file(@Param('id') id: string, @Res() response: Response) {
    const file = await this.service.getFile(id);
    response.contentType(file.contentType);
    return response.send(file.buffer);
  }

  @Post(':id/extracted-data')
  updateExtractedData(
    @Param('id') id: string,
    @Body() body: { extractedData: any[] },
  ) {
    return this.service.updateExtractedData(id, body.extractedData);
  }

  @Post(':id/validate')
  validate(
    @Param('id') id: string,
    @Body()
    body: {
      extractedData: any[];
      deleteAfterDownstream?: boolean;
      downstreamUrl?: string;
      sendKeyValuePairs?: boolean;
    },
  ) {
    return this.service.validate(
      id,
      body.extractedData,
      body.deleteAfterDownstream,
      body.downstreamUrl,
      body.sendKeyValuePairs,
    );
  }

  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() body: { deleteAfterDownstream?: boolean; downstreamUrl?: string; sendKeyValuePairs?: boolean },
  ) {
    return this.service.reject(id, body.deleteAfterDownstream, body.downstreamUrl, body.sendKeyValuePairs);
  }

  @Post(':id/reprocess')
  reprocess(@Param('id') id: string, @Body() body?: { documentTypeId?: string }) {
    return this.service.reprocess(id, body?.documentTypeId);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
