const { DefaultAzureCredential } = require('@azure/identity');
const { ServiceBusClient } = require('@azure/service-bus');

let client;
const senders = new Map();

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

async function sendServiceBusMessage(queueName, body, messageId) {
  let sender = senders.get(queueName);
  if (!sender) {
    sender = serviceBusClient().createSender(queueName);
    senders.set(queueName, sender);
  }
  await sender.sendMessages({ body, ...(messageId ? { messageId } : {}) });
}

module.exports = { sendServiceBusMessage };
