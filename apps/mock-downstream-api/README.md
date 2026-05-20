# Mock Downstream API

A mock downstream API server that receives and stores document validation requests from the main Xtract API.

## Features

- **Receive Documents**: POST endpoint at `/documents` to receive validated/rejected document data
- **Store Requests**: All incoming requests are stored in MongoDB
- **Dashboard UI**: Web interface to view all received requests in real-time
- **Auto-refresh**: Dashboard refreshes every 5 seconds automatically
- **Statistics**: View count of validated and rejected documents
- **Management**: Delete individual requests or clear all requests

## Installation

```bash
cd apps/mock-downstream-api
npm install
```

## Running the Server

### Development mode with auto-reload
```bash
npm run dev
```

### Production build
```bash
npm run build
npm run start
```

The server will listen on `http://localhost:3001`

## API Endpoints

### Receive Document
```
POST /documents
Content-Type: application/json

{
  "documentId": "...",
  "fileName": "...",
  "category": "...",
  "status": "validated|rejected",
  "extractedData": [...],
  "processedAt": "...",
  ...
}
```

Response:
```json
{
  "success": true,
  "id": "..."
}
```

### Get All Requests
```
GET /api/requests
```

### Get Single Request
```
GET /api/requests/:id
```

### Delete Request
```
DELETE /api/requests/:id
```

### Clear All Requests
```
POST /api/requests/clear
```

## Web Dashboard

Access the dashboard at `http://localhost:3001`

The dashboard displays:
- Total number of requests received
- Count of validated documents
- Count of rejected documents
- Full JSON payload for each request
- Timestamp of when each request was received
- Option to delete individual requests or clear all

## Configuration

Set the MongoDB URI via environment variable:
```bash
MONGODB_URI=mongodb://localhost:27017/xtract-downstream
```

## Integration with Main API

Configure the main Xtract API to send downstream requests to this mock API:

1. Set the downstream URL in the Configuration screen to: `http://localhost:3001/documents`
2. Validate or reject documents - they will be forwarded to this API
3. View the requests in the dashboard at `http://localhost:3001`

## Database

Requests are stored in MongoDB in the `downstream-requests` collection with the following schema:
- `documentId`: ID of the source document
- `fileName`: Original file name
- `category`: Document category
- `status`: Document status (validated/rejected)
- `extractedData`: Extracted field data
- `payload`: Full incoming payload
- `receivedAt`: Timestamp when received
