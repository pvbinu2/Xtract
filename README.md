# Xtract

Xtract is a local-first document extraction prototype.

## Stack

- React + Vite frontend
- NestJS API
- MongoDB for local persistence
- JavaScript Azure Function worker for document processing

## Business Application

Xtract is designed for organizations that need to automate document processing workflows at scale. It solves the critical challenge of extracting structured data from unstructured PDF documents efficiently and accurately.

### Key Business Benefits

- **Cost Reduction**: Automate manual document data entry, reducing labor costs and human error.
- **Faster Processing**: Process hundreds or thousands of documents quickly with intelligent classification and extraction.
- **Flexible Classification**: Support multiple document types with customizable extraction templates, enabling use across diverse business processes.
- **Quality Control**: Review, validate, and correct extracted data side-by-side with source PDFs before finalization.
- **Scalability**: Process documents on-demand with queue-based architecture supporting high-volume workflows.

### Ideal Use Cases

- **Accounts Payable**: Extract invoice details (vendor, amount, due date, line items) for automated payment processing.
- **Document Management**: Classify and extract metadata from contracts, policies, and correspondence.
- **Compliance & Auditing**: Capture required fields from regulatory documents with quality validation.
- **Healthcare**: Extract patient information, lab results, and prescriptions from medical records.
- **Finance**: Process loan applications, tax forms, and financial statements with standardized field extraction.
- **HR & Recruitment**: Extract resume data, employment history, and certifications for candidate processing.

### How It Works for Business Users

1. **Define**: Create document categories and extraction templates matching your specific business needs.
2. **Train**: Upload sample documents and refine extraction rules until accuracy meets requirements.
3. **Process**: Batch upload incoming documents for automatic classification and extraction.
4. **Validate**: Review extracted data with visual confirmation against source documents.
5. **Export**: Integrate extracted data into downstream systems and databases.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Start MongoDB:

```bash
docker compose up -d mongo
```

3. Start the API and web app:

```bash
npm run dev
```

The web app runs on `http://localhost:5173` and the API runs on `http://localhost:3000`.

## OpenAI Setup

The API uses the OpenAI Responses API for PDF extraction when an API key is configured. Copy the example environment file and add your real key:

```bash
cp apps/api/.env.example apps/api/.env
```

Set:

```bash
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-4o-mini
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=...;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;
```

Then restart the API:

```bash
npm run dev:api
```

With `OPENAI_API_KEY` present:

- Template generation uses the latest uploaded sample PDF plus your extraction prompt.
- Document upload extraction sends the uploaded PDF and finalized schema to OpenAI.
- Classifier training extracts text from every sample PDF for a document type, creates embeddings, and stores them in Qdrant.
- Automatic classification searches Qdrant first. If the best vector score is at least `CLASSIFIER_VECTOR_SCORE_THRESHOLD` (default `0.82`), the worker skips the LLM classifier call.
- If no key is configured, the app falls back to deterministic mock values for local UI testing.

Do not commit `.env` or `local.settings.json`; both are ignored.

## Processing Flow

1. Create categories and document types in Document Type Management.
2. Upload sample PDFs and describe fields to extract.
3. Generate a template, select fields, and finalize the schema.
4. Upload incoming PDFs against a category and document type.
5. Documents enter `processing`, then the worker/API mock extractor stores extraction data.
6. Open a document from the list, correct values side by side with the PDF, then submit validation.

The first implementation includes a deterministic mock extractor so the UI and persistence can run locally without a cloud OCR or LLM account. Replace `mockExtractionFromSchema` in the API or the Azure Function worker with Azure Document Intelligence/OpenAI calls when ready.

For quick local demos, the API processes selected-type uploads inline. Automatic classification requires the Azure Function worker, queue storage, and Qdrant:

```bash
docker compose up -d mongo azurite qdrant
```

Use `QDRANT_URL=http://127.0.0.1:6333` for local vector search. Optional classifier tuning env vars include `CLASSIFIER_EMBED_TEXT_LIMIT=6000`, `CLASSIFIER_TRAIN_CHUNKS_PER_DOCUMENT=6`, and `CLASSIFIER_QUERY_CHUNKS_PER_DOCUMENT=3`. To use the Azure Function worker, run the API with `PROCESSING_MODE=queue` and set `AZURE_STORAGE_CONNECTION_STRING` or `AzureWebJobsStorage`, then start `npm run dev:function`.

OpenAI requests retry rate-limit and transient errors automatically. Use `OPENAI_MAX_RETRIES=8` to tune retry attempts. The Function queue host is configured with a batch size of 1 so multi-file uploads process steadily without stampeding token-per-minute limits.

## Document Reclassification

The reclassify feature allows users to reprocess a document with a different document type, enabling quick corrections if a document was initially misclassified.

### Where to Use Reclassify

1. **Document List Page**: Click the brain icon button on any document row to open the reclassify dialog.
2. **Validation Page**: Click the "Reclassify" button in the document detail panel before submitting validation.

### How It Works

1. Open the reclassify dialog for a document.
2. Select a new **Category** from the dropdown menu.
3. The **Document Type** dropdown automatically updates to show only types in the selected category.
4. Select the correct **Document Type**.
5. Click **Reclassify** to reprocess the document.

### What Happens on Reclassify

- The document's category and document type are updated.
- All extracted data is cleared and the document status is reset to `processing`.
- The document is reprocessed with the new document type's schema and extraction rules.
- Once complete, the document status changes to `extracted` with fresh extraction data.
- You can then review and validate the new extracted values.

### Use Cases

- **Misclassified Documents**: If the automatic classification assigned a document to the wrong type.
- **Schema Changes**: When you've refined the extraction template and want to re-extract with the updated schema.
- **Manual Corrections**: After reviewing a document, reassign it to the correct category if needed.

This feature ensures documents can be corrected without needing to delete and re-upload them.
