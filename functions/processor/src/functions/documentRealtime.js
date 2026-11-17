const { app } = require('@azure/functions');
const { withFunctionLogging } = require('../functionLogger');
const { resolveMessage } = require('../documentProcessingCommon');

const broadcastUrl = process.env.REALTIME_BROADCAST_URL || '';
const realtimeEnabled = process.env.SIGNALR_ENABLED !== 'false' && Boolean(broadcastUrl);

if (realtimeEnabled) {
  app.serviceBusQueue('broadcastDocumentEvent', {
    queueName: 'document-events',
    connection: 'ServiceBusConnection',
    handler: withFunctionLogging('broadcastDocumentEvent', 'document-events', async (message, context) => {
      const event = resolveMessage(message);
      if (!event.documentId || !event.status) {
        context.warn('Skipping invalid document event.');
        return;
      }

      const response = await fetch(broadcastUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Realtime-Secret': process.env.REALTIME_BROADCAST_SECRET || 'xtract-local-realtime-secret',
        },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Self-hosted SignalR broadcast failed (${response.status}): ${body || response.statusText}`);
      }
      context.info('Document event broadcast succeeded.');
    }, { documentMessage: true }),
  });
}
