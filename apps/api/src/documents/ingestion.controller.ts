import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Public } from '../auth/auth.decorators';
import { DocumentsService } from './documents.service';
import { IngestionApiKeyGuard } from './ingestion-api-key.guard';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_METADATA_SIZE = 16 * 1024;
@Controller('ingestion')
export class IngestionController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post('documents')
  @Public()
  @UseGuards(IngestionApiKeyGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { files: 1, fileSize: MAX_FILE_SIZE } }))
  ingest(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { category?: string; type?: string; metadata?: string },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!file || !file.buffer?.length) throw new BadRequestException('A non-empty file is required.');
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (!normalizedIdempotencyKey) throw new BadRequestException('Idempotency-Key header is required.');
    if (normalizedIdempotencyKey.length > 256) throw new BadRequestException('Idempotency-Key must not exceed 256 characters.');

    return this.documentsService.ingestExternal({
      fileName: file.originalname,
      originalName: file.originalname,
      buffer: file.buffer,
      mimeType: file.mimetype,
      category: body.category?.trim(),
      type: body.type?.trim(),
      metadata: this.parseMetadata(body.metadata),
      idempotencyKey: normalizedIdempotencyKey,
    });
  }

  private parseMetadata(raw?: string) {
    if (!raw?.trim()) return undefined;
    if (Buffer.byteLength(raw, 'utf8') > MAX_METADATA_SIZE) {
      throw new BadRequestException('Metadata must not exceed 16 KB.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('Metadata must be valid JSON.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException('Metadata must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  }
}
