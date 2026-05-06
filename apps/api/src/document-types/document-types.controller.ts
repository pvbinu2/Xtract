import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { mkdirSync } from 'fs';
import { extname, join } from 'path';
import { DocumentTypesService } from './document-types.service';

const uploadDir = join(__dirname, '..', '..', 'uploads');
mkdirSync(uploadDir, { recursive: true });

const storage = diskStorage({
  destination: uploadDir,
  filename: (_req, file, callback) => {
    callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${extname(file.originalname)}`);
  },
});

@Controller('document-types')
export class DocumentTypesController {
  constructor(private readonly service: DocumentTypesService) {}

  @Get()
  list() {
    return this.service.list();
  }

  @Post()
  create(@Body() body: { category: string; name: string; prompt?: string }) {
    return this.service.create(body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/samples')
  @UseInterceptors(FileInterceptor('file', { storage }))
  addSample(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.service.addSample(id, file.filename);
  }

  @Post(':id/generate-template')
  generateTemplate(@Param('id') id: string, @Body() body: { prompt: string }) {
    return this.service.generateTemplate(id, body.prompt);
  }

  @Post(':id/finalize')
  finalize(@Param('id') id: string, @Body() body: { fields: any[] }) {
    return this.service.finalize(id, body.fields);
  }
}
