# @xtract/common

Shared infrastructure adapters used by the Xtract API and background processor.

- `MongoDatabase` owns MongoDB connection lifecycle and collection access.
- `AzureBlobStorage` owns blob upload, download, move, delete, and temporary-file handling.
- `QdrantVectorDatabase` owns vector collection lifecycle, filtered deletion, upserts, and search.
- `OcrService` coordinates embedded-text, OCR, and markdown extraction strategies.

Application modules should depend on these classes (or thin framework adapters) instead of provider SDKs. Business workflows remain in their respective application so infrastructure concerns and domain orchestration stay separate.
