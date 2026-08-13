const path = require('path');
const fs = require('fs/promises');
const { app, output } = require('@azure/functions');
const { withPreprocessingConcurrency } = require('../aiConcurrency');
const {
  ObjectId,
  beginDocumentStage,
  completeDocumentStage,
  getClient,
  hasResolvableDocumentFile,
  markDocumentFailed,
  processingOptionsFor,
  removeTempFile,
  resolveDocumentFile,
  resolveDocumentId,
} = require('../documentProcessingCommon');
const { extractDocumentContent, extractDocumentSpatialItems } = require('../documentText');
const { publishDocumentChanged } = require('../documentEvents');
const { getConfiguration } = require('../configurationCache');
const { imageBufferToPdf, isImageDocument } = require('../imageToPdf');
const { resolveDataEncryptionSettings } = require('@xtract/common');
const {
  PROCESSING_CONTAINER,
  deleteBlob,
  moveBlob,
  uploadBuffer,
} = require('../blobStorage');

const classificationQueueOutput = output.serviceBusQueue({
  queueName: 'document-classification',
  connection: 'ServiceBusConnection',
});

function sourceBlobName(document) {
  return `${document._id}/${path.posix.basename(document.storageBlobName || document.originalName || document.fileName)}`;
}

function convertedPdfBlobName(document) {
  const sourceName = path.posix.basename(document.originalName || document.fileName || 'document');
  const extension = path.posix.extname(sourceName);
  const stem = sourceName.slice(0, sourceName.length - extension.length) || 'document';
  return `${document._id}/${stem}.pdf`;
}

function textArtifactBlobName(document, mode) {
  const sourceName = path.posix.basename(document.storageBlobName || document.originalName || document.fileName);
  const stem = sourceName.slice(0, sourceName.length - path.posix.extname(sourceName).length) || 'document';
  return `${document._id}/${stem}${mode === 'markdown' ? '.md' : '.ocr'}`;
}

function spatialTextArtifactBlobName(document) {
  const sourceName = path.posix.basename(document.storageBlobName || document.originalName || document.fileName);
  const stem = sourceName.slice(0, sourceName.length - path.posix.extname(sourceName).length) || 'document';
  return `${document._id}/${stem}.spatial-text.json`;
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
  await beginDocumentStage(documents, document._id, 'preprocessed');
  if (!hasResolvableDocumentFile(document)) {
    const errorMessage = `Document file not found: ${document.filePath || 'missing filePath'}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
    return;
  }

  let localFilePath;
  try {
    const configuration = await getConfiguration();
    const settings = resolveDataEncryptionSettings(configuration);
    const storageEncryption = document.encryptionPolicy?.storageEncryptionEnabled
      ? { key: settings.storage.key, keyVersion: Number(document.encryptionPolicy.storageEncryptionKeyVersion) || 1 }
      : undefined;
    const storageKeys = { keys: settings.storage.key ? { [String(settings.storage.keyVersion)]: settings.storage.key } : {} };
    if (isImageDocument(document) && !document.convertedToPdf) {
      localFilePath = await resolveDocumentFile(document, configuration);
      const pdfBuffer = await imageBufferToPdf(await fs.readFile(localFilePath));
      const previousContainer = document.storageContainer;
      const previousBlobName = document.storageBlobName;
      const pdfBlobName = convertedPdfBlobName(document);
      await uploadBuffer(PROCESSING_CONTAINER, pdfBlobName, pdfBuffer, 'application/pdf', storageEncryption);
      await documents.updateOne(
        { _id: document._id },
        {
          $set: {
            fileName: pdfBlobName,
            filePath: `azure://${PROCESSING_CONTAINER}/${pdfBlobName}`,
            storageContainer: PROCESSING_CONTAINER,
            storageBlobName: pdfBlobName,
            convertedToPdf: true,
            updatedAt: new Date(),
          },
        },
      );
      if (previousContainer && previousBlobName && previousBlobName !== pdfBlobName) {
        await deleteBlob(previousContainer, previousBlobName);
      }
      if (document.storageContainer && document.storageBlobName) {
        await removeTempFile(localFilePath);
        localFilePath = undefined;
      }
      document = {
        ...document,
        fileName: pdfBlobName,
        filePath: `azure://${PROCESSING_CONTAINER}/${pdfBlobName}`,
        storageContainer: PROCESSING_CONTAINER,
        storageBlobName: pdfBlobName,
        convertedToPdf: true,
      };
      context.info(`Converted image ${document.originalName || document._id} to ${pdfBlobName}.`);
    }

    if (document.storageContainer === PROCESSING_CONTAINER && document.storageBlobName) {
      const nextSourceBlobName = sourceBlobName(document);
      if (document.storageBlobName !== nextSourceBlobName) {
        await moveBlob(PROCESSING_CONTAINER, document.storageBlobName, PROCESSING_CONTAINER, nextSourceBlobName, { source: storageKeys, target: storageEncryption });
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

    const { documentTextMode, textOptions } = processingOptionsFor(document, configuration);
    localFilePath = await resolveDocumentFile(document, configuration);
    const content = await extractDocumentContent(localFilePath, undefined, {
      ...textOptions,
      fileName: document.convertedToPdf
        ? path.posix.basename(document.storageBlobName || document.fileName)
        : document.originalName || document.fileName,
    });
    const artifactBlobName = textArtifactBlobName(document, documentTextMode);
    const spatialItems = await extractDocumentSpatialItems(localFilePath, { forceOcr: documentTextMode === 'markdown' });
    const spatialArtifactBlobName = spatialTextArtifactBlobName(document);
    await uploadBuffer(
      PROCESSING_CONTAINER,
      artifactBlobName,
      Buffer.from(content.text, 'utf8'),
      documentTextMode === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
      storageEncryption,
    );
    await uploadBuffer(
      PROCESSING_CONTAINER,
      spatialArtifactBlobName,
      Buffer.from(JSON.stringify({ version: 1, items: spatialItems.map((item, order) => ({ ...item, order })) }), 'utf8'),
      'application/json; charset=utf-8',
      storageEncryption,
    );
    if (
      document.textArtifactContainer &&
      document.textArtifactBlobName &&
      document.textArtifactBlobName !== artifactBlobName
    ) {
      await deleteBlob(document.textArtifactContainer, document.textArtifactBlobName);
    }
    if (
      document.spatialTextArtifactContainer &&
      document.spatialTextArtifactBlobName &&
      document.spatialTextArtifactBlobName !== spatialArtifactBlobName
    ) {
      await deleteBlob(document.spatialTextArtifactContainer, document.spatialTextArtifactBlobName);
    }
    await completeDocumentStage(
      documents,
      document._id,
      'preprocessed',
      {
        textArtifactContainer: PROCESSING_CONTAINER,
        textArtifactBlobName: artifactBlobName,
        textArtifactMode: documentTextMode,
        spatialTextArtifactContainer: PROCESSING_CONTAINER,
        spatialTextArtifactBlobName: spatialArtifactBlobName,
      },
    );
    await publishDocumentChanged(
      documents,
      document._id,
      ['status', 'textArtifactBlobName', 'textArtifactMode', 'spatialTextArtifactBlobName'],
      context,
    );

    context.info(`Prepared ${documentTextMode} for document ${document._id} at ${artifactBlobName}.`);
    context.extraOutputs.set(classificationQueueOutput, JSON.stringify({ documentId: String(document._id) }));
  } catch (error) {
    const errorMessage = `Document text preparation failed: ${error?.message || String(error)}`;
    context.error(errorMessage);
    await markDocumentFailed(documents, document._id, errorMessage);
    await publishDocumentChanged(documents, document._id, ['status', 'error'], context);
  } finally {
    if (localFilePath && document.storageContainer && document.storageBlobName) await removeTempFile(localFilePath);
  }
}

app.serviceBusQueue('prepareDocumentText', {
  queueName: 'document-processing',
  connection: 'ServiceBusConnection',
  extraOutputs: [classificationQueueOutput],
  handler: withPreprocessingConcurrency(prepareDocumentText),
});

module.exports = { convertedPdfBlobName, prepareDocumentText, sourceBlobName, spatialTextArtifactBlobName, textArtifactBlobName };
