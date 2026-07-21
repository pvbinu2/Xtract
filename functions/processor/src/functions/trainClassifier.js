const { app } = require('@azure/functions');
const { MongoClient, ObjectId } = require('mongodb');
const { resetClassifierVectors, trainClassifierProfile } = require('../classifier');

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

  const client = await getClient();
  const db = client.db();
  const documentTypes = db.collection('documenttypes');
  const configuration = await db.collection('configuration').findOne({});
  const aiOptions = {
    aiProvider: configuration?.aiProvider === 'ollama' ? 'ollama' : 'openai',
    ollamaBaseUrl: configuration?.ollamaBaseUrl,
    ollamaModel: configuration?.ollamaModel,
    embeddingProvider: configuration?.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
    embeddingModel: configuration?.embeddingModel,
    ollamaEmbeddingModel: configuration?.ollamaEmbeddingModel,
  };

  if (payload.trainAll) {
    const includedTypes = await documentTypes
      .find({
        includeInClassification: true,
        finalized: true,
        'sampleFiles.0': { $exists: true },
      })
      .toArray();

    if (!includedTypes.length) {
      context.warn('No included document types with samples found for classifier training.');
      return;
    }

    try {
      await resetClassifierVectors();
    } catch (error) {
      const errorMessage = `Classifier vector reset failed: ${error?.message || String(error)}`;
      context.error(errorMessage);
      await documentTypes.updateMany(
        { _id: { $in: includedTypes.map((documentType) => documentType._id) } },
        {
          $set: {
            classifierTrainingStatus: 'failed',
            classifierTrainingError: errorMessage,
            updatedAt: new Date(),
          },
        },
      );
      return;
    }

    for (const documentType of includedTypes) {
      try {
        const profile = await trainClassifierProfile(documentType, (documentType.sampleFiles || []).at(-1), aiOptions);
        await documentTypes.updateOne(
          { _id: documentType._id },
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
        context.error(`${documentType.name}: ${errorMessage}`);
        await documentTypes.updateOne(
          { _id: documentType._id },
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
    return;
  }

  if (!payload.documentTypeId || !ObjectId.isValid(payload.documentTypeId) || !payload.sampleFileName) {
    context.warn(`Skipping classifier training message without documentTypeId/sampleFileName: ${JSON.stringify(message)}`);
    return;
  }

  const documentTypeId = new ObjectId(payload.documentTypeId);
  const documentType = await documentTypes.findOne({ _id: documentTypeId });
  if (!documentType) {
    context.error(`Document type ${payload.documentTypeId} not found`);
    return;
  }

  try {
    const profile = await trainClassifierProfile(documentType, payload.sampleFileName, aiOptions);
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
