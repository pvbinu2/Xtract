import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';

let client: ServiceBusClient | undefined;
const senders = new Map<string, ServiceBusSender>();

function serviceBusClient() {
  if (client) return client;
  const useManagedIdentity = process.env.AZURE_USE_MANAGED_IDENTITY?.toLowerCase() === 'true';
  const connectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
  if (!useManagedIdentity && connectionString) {
    client = new ServiceBusClient(connectionString);
    return client;
  }
  const namespace = process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE;
  if (!namespace) {
    throw new Error(useManagedIdentity
      ? 'SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE is required when managed identity is enabled.'
      : 'Service Bus requires SERVICE_BUS_CONNECTION_STRING or SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE.');
  }
  const credential = useManagedIdentity
    ? (process.env.AZURE_CLIENT_ID
      ? new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID)
      : new ManagedIdentityCredential())
    : new DefaultAzureCredential();
  client = new ServiceBusClient(namespace, credential);
  return client;
}

export function hasServiceBusConfiguration() {
  const useManagedIdentity = process.env.AZURE_USE_MANAGED_IDENTITY?.toLowerCase() === 'true';
  return Boolean(useManagedIdentity
    ? process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE
    : process.env.SERVICE_BUS_CONNECTION_STRING || process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE);
}

export async function sendServiceBusMessage(queueName: string, body: unknown, messageId?: string) {
  let sender = senders.get(queueName);
  if (!sender) {
    sender = serviceBusClient().createSender(queueName);
    senders.set(queueName, sender);
  }
  await sender.sendMessages({ body, ...(messageId ? { messageId } : {}) });
}
