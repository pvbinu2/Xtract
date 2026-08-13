import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class IngestionApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const configuredKey = process.env.DOCUMENT_INGESTION_API_KEY?.trim();
    if (!configuredKey) throw new ServiceUnavailableException('Document ingestion API is not configured.');
    const supplied = context.switchToHttp().getRequest<Request>().header('x-ingestion-api-key')?.trim();
    if (!supplied || !this.matches(supplied, configuredKey)) {
      throw new UnauthorizedException('A valid ingestion API key is required.');
    }
    return true;
  }

  private matches(left: string, right: string) {
    const leftHash = createHash('sha256').update(left).digest();
    const rightHash = createHash('sha256').update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
  }
}
