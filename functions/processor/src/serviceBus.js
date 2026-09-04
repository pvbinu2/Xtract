const { DefaultAzureCredential, ManagedIdentityCredential } = require('@azure/identity');
const { ServiceBusClient } = require('@azure/service-bus');

let client;
const senders = new Map();

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

async function sendServiceBusMessage(queueName, body, messageId) {
  let sender = senders.get(queueName);
  if (!sender) {
    sender = serviceBusClient().createSender(queueName);
    senders.set(queueName, sender);
  }
  await sender.sendMessages({ body, ...(messageId ? { messageId } : {}) });
}

module.exports = { sendServiceBusMessage };
