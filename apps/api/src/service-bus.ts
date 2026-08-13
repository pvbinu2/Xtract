import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';

let client: ServiceBusClient | undefined;
const senders = new Map<string, ServiceBusSender>();

function serviceBusClient() {
  if (client) return client;
  const connectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
  if (connectionString) {
    client = new ServiceBusClient(connectionString);
    return client;
  }
  const namespace = process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE;
  if (!namespace) {
    throw new Error('Service Bus requires SERVICE_BUS_CONNECTION_STRING or SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE.');
  }
  client = new ServiceBusClient(namespace, new DefaultAzureCredential());
  return client;
}

export function hasServiceBusConfiguration() {
  return Boolean(
    process.env.SERVICE_BUS_CONNECTION_STRING
    || process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE,
  );
}

export async function sendServiceBusMessage(queueName: string, body: unknown, messageId?: string) {
  let sender = senders.get(queueName);
  if (!sender) {
    sender = serviceBusClient().createSender(queueName);
    senders.set(queueName, sender);
  }
  await sender.sendMessages({ body, ...(messageId ? { messageId } : {}) });
}
