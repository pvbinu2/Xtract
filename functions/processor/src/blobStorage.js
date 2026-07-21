const { AzureBlobStorage, PROCESSING_CONTAINER, TRAIN_CONTAINER, TRIGGER_CONTAINER } = require('@xtract/common');
const storage = new AzureBlobStorage();

module.exports = {
  PROCESSING_CONTAINER,
  TRAIN_CONTAINER,
  TRIGGER_CONTAINER,
  createBlobName: storage.createBlobName.bind(storage),
  downloadToTemp: storage.downloadToTemp.bind(storage),
  isConfigured: storage.isConfigured.bind(storage),
  moveBlob: storage.moveBlob.bind(storage),
  removeTempFile: storage.removeTempFile.bind(storage),
};
