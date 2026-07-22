import { BadRequestException, Injectable } from '@nestjs/common';
import { AzureBlobStorage, PROCESSING_CONTAINER, TRAIN_CONTAINER } from '@xtract/common';

export { PROCESSING_CONTAINER, TRAIN_CONTAINER };

@Injectable()
export class BlobStorageService extends AzureBlobStorage {
  constructor() {
    super({ errorFactory: (message) => new BadRequestException(message) });
  }
}
