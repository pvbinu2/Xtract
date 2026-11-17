const { app } = require('@azure/functions');
const { withExtractionConcurrency } = require('../aiConcurrency');
const { withFunctionLogging } = require('../functionLogger');
const { extractQueuedDocument } = require('./extractDocument');

app.serviceBusQueue('chunkExtractDocument', {
  queueName: 'document-chunk-extraction',
  connection: 'ServiceBusConnection',
  handler: withFunctionLogging('chunkExtractDocument', 'document-chunk-extraction', withExtractionConcurrency((message, context) => extractQueuedDocument(message, context, true)), { documentMessage: true }),
});
