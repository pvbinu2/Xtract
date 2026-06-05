import { Body, Controller, Get, Post } from '@nestjs/common';
import { ConfigurationService } from './configuration.service';
import { Configuration } from '../schemas/configuration.schema';

@Controller('configuration')
export class ConfigurationController {
  constructor(private readonly configurationService: ConfigurationService) {}

  @Get()
  async getConfiguration(): Promise<Configuration> {
    return this.configurationService.get();
  }

  @Post()
  async saveConfiguration(
    @Body()
    body: {
      downstreamUrl: string;
      deleteAfterDownstream: boolean;
      sendKeyValuePairs?: boolean;
      useOcrForDocumentProcessing?: boolean;
      classificationModel?: string;
      classificationReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    },
  ): Promise<Configuration> {
    return this.configurationService.save(body);
  }
}
