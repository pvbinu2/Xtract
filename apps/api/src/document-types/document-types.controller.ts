import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DocumentTypesService } from './document-types.service';

const storage = memoryStorage();

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
    return this.service.addSample(id, file);
  }

  @Post(':id/train-classifier')
  trainClassifier(@Param('id') id: string) {
    return this.service.trainClassifier(id);
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
