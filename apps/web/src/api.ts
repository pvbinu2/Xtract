import { AuthUser, BusinessReviewSummary, DemoRequest, DisplayCurrency, DocumentType, ExtractedValue, IncomingDocument, PagedResult, ReasoningEffort, UserRole } from './types';

export type AppConfigPayload = {
  storageEncryptionEnabled: boolean;
  databaseEncryptionEnabled: boolean;
  storageEncryptionKeyConfigured?: boolean;
  databaseEncryptionKeyConfigured?: boolean;
  cachingEnabled: boolean;
  configurationCacheTtlSeconds: number;
  turnstileEnabled: boolean;
  turnstileSiteKey: string;
  turnstileSecretKey: string;
  turnstileSecretKeyConfigured?: boolean;
  turnstileExpectedHostname: string;
  turnstileExpectedAction: string;
  downstreamUrl: string;
  deleteAfterDownstream: boolean;
  sendKeyValuePairs: boolean;
  useOcrForDocumentProcessing: boolean;
  documentIngestionTrigger: 'event-grid' | 'blob';
  ingestionFileTypes: Array<{
    extensions: string[];
    label: string;
    mimeTypes: string[];
    enabled: boolean;
  }>;
  documentTextMode: 'ocr' | 'markdown';
  markdownServiceUrl: string;
  aiProvider: 'openai' | 'custom' | 'ollama';
  llmEndpoint: string;
  apiKey: string;
  apiKeyConfigured?: boolean;
  openAiApiKey: string;
  openAiApiKeyConfigured?: boolean;
  customApiKey: string;
  customApiKeyConfigured?: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  embeddingProvider: 'openai' | 'ollama';
  embeddingModel: string;
  ollamaEmbeddingModel: string;
  vectorDatabaseProvider: string;
  vectorDatabaseEndpoint: string;
  vectorDatabaseApiKey: string;
  vectorDatabaseApiKeyConfigured?: boolean;
  classificationModel: string;
  classificationReasoningEffort: ReasoningEffort;
  classificationMode: 'vector' | 'llm' | 'rag';
  classificationRagTopK: number;
  preprocessingConcurrency: number;
  vectorClassificationConcurrency: number;
  llmClassificationConcurrency: number;
  extractionConcurrency: number;
};
export type ReprocessDocumentPayload = {
  documentTypeId?: string;
  extractionModel?: string;
  useOcrForDocumentProcessing?: boolean;
  documentTextMode?: 'ocr' | 'markdown';
  forceClassification?: boolean;
};

export type SpatialTextPage = {
  version: 1;
  page: number;
  items: Array<{
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
    lineKey?: string;
    order: number;
  }>;
};
export type WorkbookMetadata = { version: 1; sheets: Array<{ index: number; name: string; rowCount: number; columnCount: number }> };
export type WorkbookSheet = WorkbookMetadata['sheets'][number] & {
  version: 1;
  merges: string[];
  cells: Array<{ address: string; row: number; column: number; value: string; type: string }>;
};

export type HealthCheckResult = {
  status: 'ready' | 'degraded';
  checkedAt: string;
  summary: {
    total: number;
    ready: number;
    unavailable: number;
    notConfigured: number;
  };
  checks: Array<{
    id: string;
    name: string;
    group: 'Application' | 'Data' | 'Storage' | 'Queues' | 'Services' | 'AI';
    status: 'ready' | 'unavailable' | 'not_configured';
    detail: string;
    latencyMs: number;
  }>;
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

export type LoginSession = { token: string; user: AuthUser };
export type LoginResult =
  | LoginSession
  | { requiresTwoFactor: true; twoFactorToken: string }
  | { requiresTwoFactorSetup: true; twoFactorSetupToken: string };

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const token = authToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (!response.ok) {
    const rawMessage = await response.text();
    let message = rawMessage;
    try {
      const parsed = JSON.parse(rawMessage) as { message?: string | string[] };
      message = Array.isArray(parsed.message) ? parsed.message.join(' ') : parsed.message || rawMessage;
    } catch {
      // Keep non-JSON error responses unchanged.
    }
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function requestFile(path: string) {
  const headers = new Headers();
  const token = authToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { headers });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }
  return response.blob();
}

export const api = {
  login: (payload: { username: string; password: string }) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  verifyTwoFactorLogin: (payload: { twoFactorToken: string; code: string }) =>
    request<LoginSession>('/auth/two-factor/verify-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  beginRequiredTwoFactorSetup: (twoFactorSetupToken: string) =>
    request<{ secret: string; qrCodeDataUrl: string }>('/auth/two-factor/required-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ twoFactorSetupToken }),
    }),
  completeRequiredTwoFactorSetup: (payload: { twoFactorSetupToken: string; secret: string; code: string }) =>
    request<LoginSession>('/auth/two-factor/required-setup/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  me: () => request<AuthUser>('/auth/me'),
  getHealth: () => request<HealthCheckResult>('/health'),
  changePassword: (payload: { currentPassword: string; newPassword: string }) =>
    request<{ changed: boolean }>('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  beginTwoFactorSetup: () =>
    request<{ secret: string; qrCodeDataUrl: string }>('/auth/two-factor/setup', { method: 'POST' }),
  enableTwoFactor: (payload: { secret: string; code: string }) =>
    request<{ enabled: true }>('/auth/two-factor/enable', {
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
  documentPageText: (id: string, pageNumber: number) => request<SpatialTextPage>(`/documents/${id}/pages/${pageNumber}/text`),
  documentWorkbook: (id: string) => request<WorkbookMetadata>(`/documents/${id}/workbook`),
  documentWorkbookSheet: (id: string, sheetIndex: number) => request<WorkbookSheet>(`/documents/${id}/workbook/sheets/${sheetIndex}`),
  documentFile: (id: string) => requestFile(`/documents/${id}/file`),
  documentTextArtifact: (id: string) => requestFile(`/documents/${id}/text-artifact`),
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
    payload: {
      extractionModel: string;
      extractionAiProvider?: 'openai' | 'custom' | 'ollama';
      extractionReasoningEffort: ReasoningEffort;
      extractionVerification?: boolean;
    },
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
  getDemoRequestSettings: () => request<{ turnstileEnabled: boolean; turnstileSiteKey: string; turnstileAction: string }>('/demo-requests/settings'),
  createDemoRequest: (payload: { email: string; phone?: string; turnstileToken?: string; website?: string }) =>
    request<{ accepted: boolean }>('/demo-requests', {
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
