import { HubConnection, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import { authToken } from './api';
import { IncomingDocument } from './types';

export type DocumentChangedEvent = {
  eventId: string;
  documentId: string;
  revision: number;
  status: IncomingDocument['status'];
  changedFields: string[];
  updatedAt: string;
};

export function createDocumentRealtimeConnection(
  userId: string,
  onDocumentChanged: (event: DocumentChangedEvent) => void,
  onReconnected: () => void,
): HubConnection | undefined {
  const baseUrl = import.meta.env.VITE_REALTIME_URL?.replace(/\/$/, '');
  if (!baseUrl || !userId) return undefined;

  const connection = new HubConnectionBuilder()
    .withUrl(baseUrl, {
      accessTokenFactory: authToken,
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(import.meta.env.DEV ? LogLevel.Information : LogLevel.Warning)
    .build();

  connection.on('documentChanged', onDocumentChanged);
  connection.onreconnected(onReconnected);
  return connection;
}
