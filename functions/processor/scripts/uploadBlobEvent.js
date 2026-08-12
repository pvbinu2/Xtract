const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ServiceBusClient } = require('@azure/service-bus');

const AZURITE_CONNECTION = 'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;TableEndpoint=http://127.0.0.1:10002/devstoreaccount1;';
const SERVICE_BUS_CONNECTION = 'Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;';

function contentType(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (['.tif', '.tiff'].includes(extension)) return 'image/tiff';
  return 'application/octet-stream';
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) throw new Error('Usage: npm run event:upload -- <file> [blob-name]');
  const buffer = await fs.readFile(filePath);
  const blobName = process.argv[3] || path.basename(filePath);
  const storageConnection = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage || AZURITE_CONNECTION;
  const serviceBusConnection = process.env.SERVICE_BUS_CONNECTION_STRING || SERVICE_BUS_CONNECTION;
  const blobs = BlobServiceClient.fromConnectionString(storageConnection);
  const container = blobs.getContainerClient('trigger');
  await container.createIfNotExists();
  const blob = container.getBlockBlobClient(blobName);
  const upload = await blob.uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType(blobName) } });

  const eventId = randomUUID();
  const event = {
    id: eventId,
    topic: '/subscriptions/local/resourceGroups/local/providers/Microsoft.Storage/storageAccounts/devstoreaccount1',
    subject: `/blobServices/default/containers/trigger/blobs/${encodeURIComponent(blobName)}`,
    eventType: 'Microsoft.Storage.BlobCreated',
    eventTime: new Date().toISOString(),
    dataVersion: '1',
    metadataVersion: '1',
    data: {
      api: 'PutBlob',
      clientRequestId: randomUUID(),
      requestId: randomUUID(),
      eTag: upload.etag,
      contentType: contentType(blobName),
      contentLength: buffer.length,
      blobType: 'BlockBlob',
      url: blob.url,
      sequencer: Date.now().toString(16).padStart(16, '0'),
    },
  };

  const bus = new ServiceBusClient(serviceBusConnection);
  const sender = bus.createSender('blob-ingestion');
  try {
    await sender.sendMessages({ body: event, messageId: eventId, contentType: 'application/json' });
  } finally {
    await sender.close();
    await bus.close();
  }
  console.log(JSON.stringify({ blobName, eventId, queue: 'blob-ingestion' }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
