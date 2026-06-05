import { BusinessReviewSummary, DocumentType, ExtractedValue, IncomingDocument, PagedResult, ReasoningEffort } from './types';

export type AppConfigPayload = {
  downstreamUrl: string;
  deleteAfterDownstream: boolean;
  sendKeyValuePairs: boolean;
  useOcrForDocumentProcessing: boolean;
  classificationModel: string;
  classificationReasoningEffort: ReasoningEffort;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:3000/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json();
}

export const api = {
  documentFileUrl: (id: string) => `${API_BASE}/documents/${id}/file`,
  listDocumentTypes: () => request<DocumentType[]>('/document-types'),
  createDocumentType: (payload: { category: string; name: string; prompt?: string }) =>
    request<DocumentType>('/document-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  deleteDocumentType: (id: string) => request(`/document-types/${id}`, { method: 'DELETE' }),
  uploadSample: (id: string, file: File) => {
    const data = new FormData();
    data.append('file', file);
    return request<DocumentType>(`/document-types/${id}/samples`, { method: 'POST', body: data });
  },
  deleteSample: (id: string, fileName: string) =>
    request<DocumentType>(`/document-types/${id}/samples/${encodeURIComponent(fileName)}`, { method: 'DELETE' }),
  trainClassifier: () => request<DocumentType[]>('/document-types/train-classifier', { method: 'POST' }),
  resetClassifierTraining: () => request<DocumentType[]>('/document-types/reset-classifier-training', { method: 'POST' }),
  updateClassificationInclusion: (id: string, includeInClassification: boolean) =>
    request<DocumentType>(`/document-types/${id}/classification-inclusion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeInClassification }),
    }),
  updateExtractionModel: (id: string, payload: { extractionModel: string; extractionReasoningEffort: ReasoningEffort }) =>
    request<DocumentType>(`/document-types/${id}/extraction-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  generateTemplate: (id: string, prompt: string) =>
    request<DocumentType>(`/document-types/${id}/generate-template`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }),
  finalizeTemplate: (id: string, fields: DocumentType['fields']) =>
    request<DocumentType>(`/document-types/${id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    }),
  uploadDocument: (payload: { category?: string; documentTypeId?: string; file: File }) => {
    const data = new FormData();
    if (payload.category) data.append('category', payload.category);
    if (payload.documentTypeId) data.append('documentTypeId', payload.documentTypeId);
    data.append('files', payload.file);
    return request<IncomingDocument>('/documents/upload', { method: 'POST', body: data });
  },
  uploadDocuments: (payload: { category?: string; documentTypeId?: string; files: File[] }) => {
    const data = new FormData();
    if (payload.category) data.append('category', payload.category);
    if (payload.documentTypeId) data.append('documentTypeId', payload.documentTypeId);
    payload.files.forEach((file) => data.append('files', file));
    return request<IncomingDocument[]>('/documents/upload', { method: 'POST', body: data });
  },
  listDocuments: (params: URLSearchParams) =>
    request<PagedResult<IncomingDocument>>(`/documents?${params.toString()}`),
  getBusinessReviewSummary: () => request<BusinessReviewSummary>('/documents/business-review/summary'),
  resetBusinessReview: () => request<{ reset: boolean }>('/documents/business-review', { method: 'DELETE' }),
  deleteDocument: (id: string) => request(`/documents/${id}`, { method: 'DELETE' }),
  reprocessDocument: (id: string) => request<IncomingDocument>(`/documents/${id}/reprocess`, { method: 'POST' }),
  reclassifyDocument: (id: string, documentTypeId: string) =>
    request<IncomingDocument>(`/documents/${id}/reprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentTypeId }),
    }),
  getDocument: (id: string) => request<IncomingDocument>(`/documents/${id}`),
  updateExtractedData: (id: string, extractedData: ExtractedValue[]) =>
    request<IncomingDocument>(`/documents/${id}/extracted-data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extractedData }),
    }),
  validateDocument: (
    id: string,
    extractedData: ExtractedValue[],
    deleteAfterDownstream = false,
    downstreamUrl?: string,
    sendKeyValuePairs = false,
  ) =>
    request<any>(`/documents/${id}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extractedData, deleteAfterDownstream, downstreamUrl, sendKeyValuePairs }),
    }),
  getConfiguration: () =>
    request<Partial<AppConfigPayload>>('/configuration'),
  saveConfiguration: (payload: AppConfigPayload) =>
    request<AppConfigPayload>('/configuration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  rejectDocument: (
    id: string,
    deleteAfterDownstream = false,
    downstreamUrl?: string,
    sendKeyValuePairs = false,
  ) =>
    request<IncomingDocument>(`/documents/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteAfterDownstream, downstreamUrl, sendKeyValuePairs }),
    }),
};
