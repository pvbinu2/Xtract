const path = require('path');
const { app, output } = require('@azure/functions');
const {
  ObjectId,
  getClient,
  hasResolvableDocumentFile,
  markDocumentFailed,
  processingOptionsFor,
  removeTempFile,
  resolveDocumentFile,
  resolveDocumentId,
} = require('../documentProcessingCommon');
const { extractDocumentContent } = require('../documentText');
const {
  PROCESSING_CONTAINER,
  deleteBlob,
  moveBlob,
  uploadBuffer,
} = require('../blobStorage');

const classificationQueueOutput = output.storageQueue({
  queueName: 'document-classification',
  connection: 'AzureWebJobsStorage',
});

function sourceBlobName(document) {
  return `${document._id}/${path.posix.basename(document.storageBlobName || document.originalName || document.fileName)}`;
}

function textArtifactBlobName(document, mode) {
  const sourceName = path.posix.basename(document.storageBlobName || document.originalName || document.fileName);
  const stem = sourceName.slice(0, sourceName.length - path.posix.extname(sourceName).length) || 'document';
  return `${document._id}/${stem}${mode === 'markdown' ? '.md' : '.ocr'}`;
}

async function prepareDocumentText(message, context) {
  const documentId = resolveDocumentId(message);
  if (!documentId || !ObjectId.isValid(documentId)) {
    context.warn(`Skipping text preparation message without a valid documentId: ${JSON.stringify(message)}`);
    return;
  }

  const client = await getClient();
  const db = client.db();
  const documents = db.collection('incomingdocuments');
  let document = await documents.findOne({ _id: new ObjectId(documentId) });
  if (!document) {
    context.error(`Document ${documentId} not found`);
    return;
  }
  if (!hasResolvableDocumentFile(document)) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    return;
  }

  let localFilePath;
  try {
    if (document.storageContainer === PROCESSING_CONTAINER && document.storageBlobName) {
      const nextSourceBlobName = sourceBlobName(document);
      if (document.storageBlobName !== nextSourceBlobName) {
        await moveBlob(PROCESSING_CONTAINER, document.storageBlobName, PROCESSING_CONTAINER, nextSourceBlobName);
        await documents.updateOne(
          { _id: document._id },
          {
            $set: {
              fileName: nextSourceBlobName,
              filePath: `azure://${PROCESSING_CONTAINER}/${nextSourceBlobName}`,
              storageBlobName: nextSourceBlobName,
              updatedAt: new Date(),
            },
          },
        );
        document = {
          ...document,
          fileName: nextSourceBlobName,
          filePath: `azure://${PROCESSING_CONTAINER}/${nextSourceBlobName}`,
          storageBlobName: nextSourceBlobName,
        };
      }
    }

    const configuration = await db.collection('configuration').findOne({});
    const { documentTextMode, textOptions } = processingOptionsFor(document, configuration);
    localFilePath = await resolveDocumentFile(document);
    const content = await extractDocumentContent(localFilePath, undefined, {
      ...textOptions,
      fileName: document.originalName || document.fileName,
    });
    const artifactBlobName = textArtifactBlobName(document, documentTextMode);
    await uploadBuffer(
      PROCESSING_CONTAINER,
      artifactBlobName,
      Buffer.from(content.text, 'utf8'),
      documentTextMode === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
    );
    if (
      document.textArtifactContainer &&
      document.textArtifactBlobName &&
      document.textArtifactBlobName !== artifactBlobName
    ) {
      await deleteBlob(document.textArtifactContainer, document.textArtifactBlobName);
    }
    await documents.updateOne(
      { _id: document._id },
      {
        $set: {
          textArtifactContainer: PROCESSING_CONTAINER,
          textArtifactBlobName: artifactBlobName,
          textArtifactMode: documentTextMode,
          status: 'preprocessed',
          updatedAt: new Date(),
        },
      },
    );

    context.info(`Prepared ${documentTextMode} for document ${document._id} at ${artifactBlobName}.`);
    context.extraOutputs.set(classificationQueueOutput, JSON.stringify({ documentId: String(document._id) }));
  } catch (error) {
    const errorMessage = `Document text preparation failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
  } finally {
    if (localFilePath && document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
  }
}

app.storageQueue('prepareDocumentText', {
  queueName: 'document-processing',
  connection: 'AzureWebJobsStorage',
  extraOutputs: [classificationQueueOutput],
  handler: prepareDocumentText,
});

module.exports = { prepareDocumentText, sourceBlobName, textArtifactBlobName };
