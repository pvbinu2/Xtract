import { Body, Controller, Delete, Get, Param, Post, Query, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { DocumentsService } from './documents.service';

const uploadDir = join(__dirname, '..', '..', 'uploads');
mkdirSync(uploadDir, { recursive: true });

const storage = diskStorage({
  destination: uploadDir,
  filename: (_req, file, callback) => {
    callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(file.originalname)}`);
  },
});

@Controller('documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  list(@Query() query: {
    status?: string;
    category?: string;
    documentTypeId?: string;
    sort?: string;
    page?: string;
    pageSize?: string;
  }) {
    return this.service.list(query);
  }

  @Post('upload')
  @UseInterceptors(FilesInterceptor('files', 50, { storage }))
  upload(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { category?: string; documentTypeId?: string },
  ) {
    return this.service.upload(
      files.map((file) => ({
        fileName: file.filename,
        originalName: file.originalname,
        filePath: file.path,
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
    const document = await this.service.findById(id);
    return response.sendFile(document.filePath);
  }

  @Post(':id/validate')
  validate(@Param('id') id: string, @Body() body: { extractedData: any[] }) {
    return this.service.validate(id, body.extractedData);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string) {
    return this.service.reject(id);
  }

  @Post(':id/reprocess')
  reprocess(@Param('id') id: string) {
    return this.service.reprocess(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
