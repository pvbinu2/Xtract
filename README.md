# Xtract

Xtract is a local-first document extraction prototype.

## Stack

- React + Vite frontend
- NestJS API
- MongoDB for local persistence
- JavaScript Azure Function worker for document processing

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

For quick local demos, the API processes uploaded documents inline. To use the Azure Function worker instead, run the API with `PROCESSING_MODE=queue` and set `AZURE_STORAGE_CONNECTION_STRING` or `AzureWebJobsStorage`, then start `npm run dev:function`.
