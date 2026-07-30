const { app } = require('@azure/functions');
const { decryptSecret, MongoDatabase, ObjectId } = require('@xtract/common');
const { resetClassifierVectors, trainClassifierProfile } = require('../classifier');

const database = new MongoDatabase();

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

  const db = await database.database();
  const documentTypes = db.collection('documenttypes');
  const configuration = await db.collection('configuration').findOne({});
  const openAiApiKey = decryptSecret(
    configuration?.encryptedOpenAiApiKey
      || (configuration?.aiProvider === 'openai' ? configuration?.encryptedApiKey : ''),
  );
  const customApiKey = decryptSecret(
    configuration?.encryptedCustomApiKey
      || (configuration?.aiProvider === 'custom' ? configuration?.encryptedApiKey : ''),
  );
  const selectedProvider = ['openai', 'custom', 'ollama'].includes(configuration?.aiProvider)
    ? configuration.aiProvider
    : 'openai';
  const aiOptions = {
    aiProvider: selectedProvider,
    apiKey: selectedProvider === 'custom' ? customApiKey : openAiApiKey,
    llmEndpoint: configuration?.llmEndpoint || '',
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
              classifierTrainedBy: payload.trainedBy || 'Unknown user',
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
          classifierTrainedBy: payload.trainedBy || 'Unknown user',
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
