import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { extname } from 'path';
import { Public } from '../auth/auth.decorators';
import { DocumentsService } from './documents.service';
import { IngestionApiKeyGuard } from './ingestion-api-key.guard';

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_METADATA_SIZE = 16 * 1024;
const supportedTypes: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.avif': ['image/avif'],
  '.bmp': ['image/bmp'],
  '.gif': ['image/gif'],
  '.heic': ['image/heic'],
  '.heif': ['image/heif'],
  '.jpeg': ['image/jpeg'],
  '.jpg': ['image/jpeg'],
  '.png': ['image/png'],
  '.svg': ['image/svg+xml'],
  '.tif': ['image/tiff'],
  '.tiff': ['image/tiff'],
  '.webp': ['image/webp'],
};

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
    this.validateFile(file);
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

  private validateFile(file: Express.Multer.File) {
    const extension = extname(file.originalname).toLowerCase();
    const allowedMimeTypes = supportedTypes[extension];
    if (!allowedMimeTypes || !allowedMimeTypes.includes(file.mimetype.toLowerCase())) {
      throw new UnsupportedMediaTypeException('Only PDF and supported image files are accepted.');
    }
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
