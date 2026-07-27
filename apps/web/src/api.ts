import { AuthUser, BusinessReviewSummary, DemoRequest, DisplayCurrency, DocumentType, ExtractedValue, IncomingDocument, PagedResult, ReasoningEffort, UserRole } from './types';

export type AppConfigPayload = {
  downstreamUrl: string;
  deleteAfterDownstream: boolean;
  sendKeyValuePairs: boolean;
  useOcrForDocumentProcessing: boolean;
  documentTextMode: 'ocr' | 'markdown';
  markdownServiceUrl: string;
  aiProvider: 'openai' | 'ollama';
  ollamaBaseUrl: string;
  ollamaModel: string;
  embeddingProvider: 'openai' | 'ollama';
  embeddingModel: string;
  ollamaEmbeddingModel: string;
  classificationModel: string;
  classificationReasoningEffort: ReasoningEffort;
  classificationMode: 'vector' | 'llm' | 'rag';
  classificationRagTopK: number;
};
export type ReprocessDocumentPayload = {
  documentTypeId?: string;
  extractionModel?: string;
  useOcrForDocumentProcessing?: boolean;
  documentTextMode?: 'ocr' | 'markdown';
  forceClassification?: boolean;
};

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:3000/api';
const AUTH_TOKEN_KEY = 'xtract-auth-token';

export function authToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

export function saveAuthToken(token: string) {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = authToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json();
}

export const api = {
  login: (payload: { username: string; password: string }) =>
    request<{ token: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  me: () => request<AuthUser>('/auth/me'),
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ changed: boolean }>('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updatePreferences: (payload: { preferredCurrency: DisplayCurrency }) =>
    request<AuthUser>('/auth/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  listUsers: () => request<AuthUser[]>('/users'),
  createUser: (payload: { username: string; password: string; role: UserRole; enabled?: boolean }) =>
    request<AuthUser>('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  updateUser: (id: string, payload: { role?: UserRole; enabled?: boolean }) =>
    request<AuthUser>(`/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  resetUserPassword: (id: string, password: string) =>
    request<AuthUser>(`/users/${id}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
  deleteUser: (id: string) => request<{ deleted: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  documentPageFile: async (id: string, pageNumber: number) => {
    const headers = new Headers();
    const token = authToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${API_BASE}/documents/${id}/pages/${pageNumber}/file`, { headers });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
  documentPageCount: (id: string) => request<{ pageCount: number }>(`/documents/${id}/page-count`),
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
  updateExtractionModel: (
    id: string,
    payload: { extractionModel: string; extractionReasoningEffort: ReasoningEffort; extractionVerification?: boolean },
  ) =>
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
  createDemoRequest: (payload: { email: string; phone?: string; source?: string }) =>
    request<DemoRequest>('/demo-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  listDemoRequests: () => request<DemoRequest[]>('/demo-requests'),
  deleteDocument: (id: string) => request(`/documents/${id}`, { method: 'DELETE' }),
  reprocessDocument: (id: string, payload: ReprocessDocumentPayload = {}) =>
    request<IncomingDocument>(`/documents/${id}/reprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
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
  validateDocument: (id: string, extractedData: ExtractedValue[]) =>
    request<any>(`/documents/${id}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extractedData }),
    }),
  getConfiguration: () =>
    request<Partial<AppConfigPayload>>('/configuration'),
  saveConfiguration: (payload: AppConfigPayload) =>
    request<AppConfigPayload>('/configuration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  rejectDocument: (id: string) =>
    request<IncomingDocument>(`/documents/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
};
