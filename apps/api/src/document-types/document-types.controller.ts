import { Body, Controller, Delete, Get, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { DocumentTypesService } from './document-types.service';
import { Roles } from '../auth/auth.decorators';
import { AuthenticatedRequest } from '../auth/auth.guard';

const storage = memoryStorage();

@Controller('document-types')
@Roles('admin')
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

  @Get(':id/samples/:fileName')
  async getSample(
    @Param('id') id: string,
    @Param('fileName') fileName: string,
    @Res() response: Response,
  ) {
    const sample = await this.service.getSample(id, decodeURIComponent(fileName));
    response.contentType(sample.contentType);
    response.setHeader('Content-Disposition', `inline; filename="${sample.fileName.replace(/["\r\n]/g, '_')}"`);
    return response.send(sample.buffer);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post('train-classifier')
  trainClassifier(@Req() request: AuthenticatedRequest) {
    return this.service.trainClassifier(request.user?.username || 'Unknown user');
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

  @Post(':id/extraction-model')
  updateExtractionModel(
    @Param('id') id: string,
    @Body() body: {
      extractionModel?: string;
      extractionAiProvider?: 'openai' | 'custom' | 'ollama';
      extractionReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
      extractionVerification?: boolean;
    },
  ) {
    return this.service.updateExtractionModel(id, body);
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
