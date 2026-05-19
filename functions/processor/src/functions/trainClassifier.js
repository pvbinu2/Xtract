const { app } = require('@azure/functions');
const { MongoClient, ObjectId } = require('mongodb');
const { trainClassifierProfile } = require('../classifier');

let clientPromise;

function getClient() {
  if (!clientPromise) {
    clientPromise = new MongoClient(process.env.MONGODB_URI || 'mongodb://localhost:27017/xtract').connect();
  }
  return clientPromise;
}

function resolveMessage(message) {
  if (typeof message === 'string') {
    try {
      return JSON.parse(message);
    } catch {
      return {};
    }
  }
  return message || {};
}

async function trainClassifier(message, context) {
  const payload = resolveMessage(message);
  if (!payload.documentTypeId || !ObjectId.isValid(payload.documentTypeId) || !payload.sampleFileName) {
    context.warn(`Skipping classifier training message without documentTypeId/sampleFileName: ${JSON.stringify(message)}`);
    return;
  }

  const client = await getClient();
  const documentTypes = client.db().collection('documenttypes');
  const documentTypeId = new ObjectId(payload.documentTypeId);
  const documentType = await documentTypes.findOne({ _id: documentTypeId });
  if (!documentType) {
    context.error(`Document type ${payload.documentTypeId} not found`);
    return;
  }

  try {
    const profile = await trainClassifierProfile(documentType, payload.sampleFileName);
    await documentTypes.updateOne(
      { _id: documentTypeId },
      {
        $set: {
          classifierProfile: profile,
          classifierTrainingStatus: 'trained',
          classifierTrainedAt: new Date(),
          classifierTrainingError: null,
          updatedAt: new Date(),
        },
      },
    );
  } catch (error) {
    const errorMessage = `Classifier training failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await documentTypes.updateOne(
      { _id: documentTypeId },
      {
        $set: {
          classifierTrainingStatus: 'failed',
          classifierTrainingError: errorMessage,
          updatedAt: new Date(),
        },
      },
    );
  }
}

app.storageQueue('trainClassifier', {
  queueName: 'classifier-training',
  connection: 'AzureWebJobsStorage',
  handler: trainClassifier,
});
