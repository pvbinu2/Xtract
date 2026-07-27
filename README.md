# Xtract

Xtract is a local-first document extraction prototype for classifying PDF documents, extracting structured data, reviewing results, and sending validated output to downstream systems.

## Business Perspective

Xtract is designed for organizations that need to automate document processing workflows at scale. It solves the challenge of extracting structured data from unstructured PDF documents efficiently, consistently, and with a human validation step before final submission.

### Key Business Benefits

- **Cost reduction**: Automate manual document data entry, reducing labor cost and human error.
- **Faster processing**: Process batches of documents with intelligent classification and extraction.
- **Flexible classification**: Support multiple document categories and extraction templates for different business workflows.
- **Quality control**: Review, validate, and correct extracted data side-by-side with the source PDF.
- **Operational visibility**: Track processed files, token usage, and estimated processing cost in the business review screen.
- **Downstream integration**: Submit validated document data to another API and optionally delete local documents after forwarding.

### Ideal Use Cases

- **Accounts payable**: Extract invoice details such as vendor, amount, due date, and line items.
- **Document management**: Classify contracts, policies, correspondence, and supporting records.
- **Compliance and auditing**: Capture required fields from regulatory documents with reviewable evidence.
- **Healthcare**: Extract patient information, lab results, prescriptions, and administrative records.
- **Finance**: Process loan applications, tax forms, statements, and supporting documents.
- **HR and recruitment**: Extract resume data, employment history, certifications, and candidate records.

### Business Workflow

1. **Define** document categories and extraction templates.
2. **Train** classification with sample documents.
3. **Process** incoming PDFs through classification and extraction.
4. **Validate** extracted data against the source PDF.
5. **Export** clean JSON data to downstream systems.

## Features and Tech Stack

### Core Features

- Document type management with configurable extraction schemas.
- Sample PDF upload for template generation and classifier training.
- Configurable classification using the top vector result, an LLM with all document types, or RAG with the top vector-retrieved types.
- PDF extraction through OpenAI, built-in text extraction, or Docling markdown extraction.
- Blob-triggered ingestion from the `trigger` storage container into the existing processing workflow.
- Validation screen with source PDF preview and editable extracted fields.
- Reclassification and reprocessing when a document was assigned to the wrong type or a schema changes.
- Business review dashboard with processed-file counts, token usage, estimated cost, and display currency conversion.
- Configurable downstream API delivery with optional document deletion after successful forwarding.
- Mock downstream API UI for testing validation payloads and Docling markdown output.

### Tech Stack

- **Frontend**: React + Vite
- **API**: NestJS
- **Persistence**: MongoDB
- **Document storage and queueing**: Azure Blob Storage and Azure Queue Storage, with Azurite for local development
- **Processing worker**: JavaScript Azure Function
- **Markdown extraction**: Python Azure Function using Docling
- **Vector search**: Qdrant
- **AI extraction and classification**: OpenAI Responses API, embeddings, and model-based structured extraction
- **Local orchestration**: Docker Compose

### Processing Modes

The document processing configuration supports three modes:

- **Direct PDF processing**: Leave **Use extracted text for document processing** unchecked. Xtract sends the full PDF to the model.
- **Built in text extraction**: Check **Use extracted text for document processing** and select **Built in** as the text extraction engine.
- **Docling markdown extraction**: Check **Use extracted text for document processing**, select **Markdown (Docling service)**, and provide the Docling service URL.

### Authentication and Roles

Xtract stores users in MongoDB and requires login with a username and password. If the users collection is empty, the API creates a local admin user on startup:

```text
username: admin
password: admin123
```

Override these defaults with `DEFAULT_ADMIN_USERNAME` and `DEFAULT_ADMIN_PASSWORD`. Set `JWT_SECRET` for non-local environments.

Roles:

- **Admin**: full application access, including user management.
- **Validator**: access to document list and validation workflows only.

### Blob Trigger Ingestion

The processor Function app includes a blob trigger for the `trigger` storage container. When a new file is uploaded to `trigger`, the function moves it to the `processing` container, creates an `IncomingDocument` record with `status: received`, and enqueues the `document-processing` queue. Files in the processing container use a document-scoped layout: `{documentId}/{source-file}` plus `{documentId}/{source-name}.ocr` or `.md`. The prepared text artifact is reused by classification and extraction.

### Real-time Document Status

Document status changes are broadcast through the self-hosted ASP.NET Core SignalR service in `services/realtime`. Docker Compose exposes the hub at `http://127.0.0.1:5080/hubs/documents`. The hub validates the same JWT issued by the API and accepts backend broadcasts through a separately protected internal endpoint.

```text
SIGNALR_ENABLED=true
JWT_SECRET=<same value for API, Functions, and realtime service>
REALTIME_BROADCAST_SECRET=<shared backend-only secret>
REALTIME_BROADCAST_URL=http://realtime:5080/internal/document-changed
VITE_REALTIME_URL=http://127.0.0.1:5080/hubs/documents
```

The Function broadcaster consumes `document-events` and posts each event to the internal endpoint. The hub broadcasts `documentChanged` to authenticated admin and validator clients. The browser applies status events immediately and performs a debounced REST refresh. Set `WEB_ORIGIN` to the allowed browser origins. When `SIGNALR_ENABLED=false` or `VITE_REALTIME_URL` is absent, processing and manual REST refresh continue without real-time updates.

### Docling Markdown Extraction

The Docling service lives in `functions/docling-markdown`. It is a Python Azure Function exposed at `/api/extract-markdown`. It accepts JSON containing a PDF as base64 and returns markdown that can be used for document classification, schema generation, and extraction.

Request shape:

```json
{
  "fileName": "invoice.pdf",
  "fileBase64": "..."
}
```

Successful response shape:

```json
{
  "engine": "docling",
  "fileName": "invoice.pdf",
  "markdown": "# ...",
  "elements": [
    {
      "text": "Invoice number INV-10425",
      "page": 0,
      "x": 0.12,
      "y": 0.18,
      "width": 0.31,
      "height": 0.03
    }
  ]
}
```

The optional `elements` array contains normalized Docling provenance coordinates used to highlight extracted values. OCR mode similarly retains Tesseract TSV word coordinates for scanned PDFs.

Bounding-box generation is independent of the selected model input mode. If a PDF has no usable embedded text layer and no Docling coordinates, the processor automatically runs Tesseract TSV to obtain word-level coordinates, including when the model processes the PDF directly.

The mock downstream API includes a **Docling Markdown** tab that can send a test PDF to a Docling target URL, show rendered markdown, and download the markdown output.

### Reclassification and Reprocessing

Reclassification lets users correct documents that were assigned to the wrong type:

1. Open a document from the document list or validation page.
2. Choose **Reclassify**.
3. Select the correct category and document type.
4. Reprocess the document with the selected schema.
5. Review and validate the fresh extracted values.

This is useful for misclassified documents, schema changes, and manual corrections without deleting and re-uploading the source PDF.

## Local Environment and End-to-End Run

### Prerequisites

- Node.js 20+
- npm
- Docker Desktop or another Docker Compose-compatible runtime
- OpenAI API key for real AI extraction and classification

### Install Dependencies

```bash
npm install
```

### Start Core Infrastructure

For a minimal UI/API run with local persistence:

```bash
docker compose up -d mongo
```

For end-to-end queue processing, classification, storage, and Docling markdown extraction:

```bash
docker compose up -d mongo azurite qdrant docling-markdown
```

Docling is exposed to the host at:

```text
http://127.0.0.1:7072/api/extract-markdown
```

Containers use the internal Docker URL:

```text
http://docling-markdown:7072/api/extract-markdown
```

### Configure OpenAI and Storage

Copy the API environment file:

```bash
cp apps/api/.env.example apps/api/.env
```

Set the required values:

```bash
OPENAI_API_KEY=sk-your-key
OPENAI_MODEL=gpt-4o-mini
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=...;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;
QDRANT_URL=http://127.0.0.1:6333
DOCLING_MARKDOWN_SERVICE_URL=http://127.0.0.1:7072/api/extract-markdown
```

Do not commit `.env` or `local.settings.json`; both are ignored.

### Run the Application

Start the API and web app:

```bash
npm run dev
```

The web app runs on:

```text
http://localhost:5173
```

The API runs on:

```text
http://localhost:3000
```

Document processing always runs through the Azure Function worker. A document progresses through the persisted statuses **Received**, **Preprocessed**, **Classified**, and **Extracted**. The API enqueues work on `document-processing`; the text-preparation function creates the stored OCR/markdown artifact and enqueues `document-classification`; classification then enqueues `document-extraction`. The Configuration screen's **Scaling** section controls independent preprocessing, vector-classification, LLM/RAG-classification, and extraction concurrency limits from 1 to 16. Saved limits apply to subsequent queue invocations without restarting the Function App. Environment fallbacks are `PREPROCESSING_CONCURRENCY`, `VECTOR_CLASSIFICATION_CONCURRENCY`, `LLM_CLASSIFICATION_CONCURRENCY`, and `EXTRACTION_CONCURRENCY`. Make sure `AZURE_STORAGE_CONNECTION_STRING` or `AzureWebJobsStorage` is set for the API and function app, then start:

```bash
npm run dev:function
```

### Run the Mock Downstream API

The mock downstream API is useful for testing validation submits and Docling markdown extraction:

```bash
docker compose up -d mock-downstream-api
```

It runs on:

```text
http://localhost:3001
```

In Xtract, open **Configuration**, expand **Downstream Configuration**, and set the downstream URL to the mock API endpoint you want to test.

### Configure Document Processing in the UI

Open **Configuration** in the web app:

1. Expand **Document Processing Configuration**.
2. Check **Use extracted text for document processing** if you want text or markdown extraction before model calls.
3. Select **Built in** for built-in extraction or **Markdown (Docling service)** for Docling.
4. For Docling, set the URL to `http://127.0.0.1:7072/api/extract-markdown` when using the browser-hosted app.
5. Save the configuration.

When running the full Docker Compose app containers, use:

```text
http://docling-markdown:7072/api/extract-markdown
```

### End-to-End Workflow

1. Create categories and document types in Document Type Management.
2. Upload sample PDFs and describe the fields to extract.
3. Generate a template, select fields, and finalize the schema.
4. Train or refresh classifier data for the document type.
5. Upload incoming PDFs.
6. Let the API or worker process documents into `extracted` status.
7. Open a document from the list and review extracted values beside the PDF.
8. Validate or reject the document.
9. Confirm the downstream payload in the mock downstream API or your configured target system.
10. Review volume, token usage, and estimated cost in Business Review.

### Runtime Notes

- With `OPENAI_API_KEY` present, uploads use Azure Blob Storage, template generation and extraction use OpenAI, and classifier training stores embeddings in Qdrant.
- When using Ollama from Docker Compose, set the app configuration's Ollama base URL to `http://host.docker.internal:11434`. The `xtract-apps` service also defaults `OLLAMA_MODEL=llama3.2` and `OLLAMA_EMBEDDING_MODEL=qwen3-embedding:4b`.
- If no OpenAI key is configured, the app falls back to deterministic mock values for local UI testing.
- Classification mode is configured in the application: **Vector** selects Qdrant's top result, **LLM** sends all eligible document types to the model, and **RAG** sends only the configured top-K vector-retrieved types to the model.
- Optional classifier tuning env vars include `CLASSIFIER_EMBED_TEXT_LIMIT=6000`, `CLASSIFIER_TRAIN_CHUNKS_PER_DOCUMENT=6`, and `CLASSIFIER_QUERY_CHUNKS_PER_DOCUMENT=3`.
- OpenAI requests retry rate-limit and transient errors automatically. Use `OPENAI_MAX_RETRIES=8` to tune retry attempts.
- The Function queue host is configured with a batch size of 1 so multi-file uploads process steadily without stampeding token-per-minute limits.
