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

  @Post(':id/samples')
  @UseInterceptors(FileInterceptor('file', { storage }))
  addSample(@Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.service.addSample(id, file);
  }

  @Delete(':id/samples/:fileName')
  removeSample(@Param('id') id: string, @Param('fileName') fileName: string) {
    return this.service.removeSample(id, decodeURIComponent(fileName));
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('train-classifier')
  trainClassifier() {
    return this.service.trainClassifier();
  }

  @Post('reset-classifier-training')
  resetClassifierTrainingStatus() {
    return this.service.resetClassifierTrainingStatus();
  }

  @Post(':id/classification-inclusion')
  updateClassificationInclusion(
    @Param('id') id: string,
    @Body() body: { includeInClassification: boolean },
  ) {
    return this.service.updateClassificationInclusion(id, Boolean(body.includeInClassification));
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
