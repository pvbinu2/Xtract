import { DocumentType, ExtractedValue, IncomingDocument, PagedResult } from './types';

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
  uploadDocument: (payload: { category: string; documentTypeId: string; file: File }) => {
    const data = new FormData();
    data.append('category', payload.category);
    data.append('documentTypeId', payload.documentTypeId);
    data.append('file', payload.file);
    return request<IncomingDocument>('/documents/upload', { method: 'POST', body: data });
  },
  listDocuments: (params: URLSearchParams) =>
    request<PagedResult<IncomingDocument>>(`/documents?${params.toString()}`),
  deleteDocument: (id: string) => request(`/documents/${id}`, { method: 'DELETE' }),
  reprocessDocument: (id: string) => request<IncomingDocument>(`/documents/${id}/reprocess`, { method: 'POST' }),
  getDocument: (id: string) => request<IncomingDocument>(`/documents/${id}`),
  validateDocument: (id: string, extractedData: ExtractedValue[]) =>
    request<IncomingDocument>(`/documents/${id}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extractedData }),
    }),
};
