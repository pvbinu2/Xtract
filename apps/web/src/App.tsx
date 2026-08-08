import { ChangeEvent, FormEvent, Fragment, PointerEvent as ReactPointerEvent, useEffect, useMemo, useState, useRef } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import Chart from 'chart.js/auto';
import {
  CheckCircle2,
  Activity,
  BarChart3,
  Building2,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ClipboardCheck,
  Clock3,
  Moon,
  PlusCircle,
  FilePlus2,
  FileSearch,
  Files,
  Gauge,
  ScanText,
  Network,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  RefreshCw,
  Save,
  Search,
  Sun,
  X,
  CircleX,
  CircleHelp,
  Trash2,
  Upload,
  Download,
  Database,
  FileText,
  FileImage,
  FileSpreadsheet,
  File as GenericFileIcon,
  KeyRound,
  Mail,
  Phone,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users as UsersIcon,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api, AppConfigPayload, clearAuthToken, HealthCheckResult, ReprocessDocumentPayload, saveAuthToken } from './api';
import { createDocumentRealtimeConnection } from './document-realtime';
import { AuthUser, BusinessReviewSummary, DemoRequest, DisplayCurrency, DocumentType, ExtractedValue, ExtractionField, FieldType, IncomingDocument, PagedResult, ReasoningEffort, TableColumn, UserRole } from './types';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();

type View = 'types' | 'classification' | 'upload' | 'documents' | 'validation' | 'configuration' | 'business-review' | 'demo-requests' | 'password-reset' | 'users' | 'health';

type AppConfig = AppConfigPayload;
type AiProvider = AppConfig['aiProvider'];
type EmbeddingProvider = AppConfig['embeddingProvider'];
type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  execute: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}
type OperationsMetrics = {
  filesProcessed: number;
  totalCostUsd: number;
  filesProcessing: number;
  filesReady: number;
};
type DocumentStatusFilter = IncomingDocument['status'] | 'in-progress' | '';
type ReprocessProcessingMode = 'pdf' | 'ocr' | 'markdown';
type UserStatusFilter = 'all' | 'active' | 'inactive';
type UserRoleFilter = 'all' | UserRole;

const fieldTypes: FieldType[] = ['string', 'number', 'date', 'currency', 'boolean', 'table'];
const lowCostOpenAIModel = 'gpt-5-nano';
const defaultOllamaBaseUrl = 'http://127.0.0.1:11434';
const defaultOllamaModel = 'llama3.2';
const defaultOpenAIEmbeddingModel = 'text-embedding-3-small';
const defaultOllamaEmbeddingModel = 'qwen3-embedding:4b';
let turnstileScriptPromise: Promise<void> | undefined;

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Verification could not be loaded. Please try again.'));
      document.head.appendChild(script);
    });
  }
  return turnstileScriptPromise;
}

async function requestTurnstileToken(sitekey: string, action: string) {
  await loadTurnstileScript();
  if (!window.turnstile) throw new Error('Verification could not be loaded. Please try again.');
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new Promise<string>((resolve, reject) => {
    let widgetId = '';
    const cleanup = () => {
      if (widgetId) window.turnstile?.remove(widgetId);
      container.remove();
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Verification timed out. Please try again.'));
    }, 10000);
    widgetId = window.turnstile!.render(container, {
      sitekey,
      action,
      size: 'invisible',
      callback: (token: string) => {
        window.clearTimeout(timeout);
        cleanup();
        resolve(token);
      },
      'error-callback': () => {
        window.clearTimeout(timeout);
        cleanup();
        reject(new Error('Verification failed. Please try again.'));
      },
      'expired-callback': () => {
        window.clearTimeout(timeout);
        cleanup();
        reject(new Error('Verification expired. Please try again.'));
      },
    });
    window.turnstile!.execute(widgetId);
  });
}
const openAIEmbeddingModelOptions = [
  { value: 'text-embedding-3-small', label: 'Text Embedding 3 Small' },
  { value: 'text-embedding-3-large', label: 'Text Embedding 3 Large' },
  { value: 'text-embedding-ada-002', label: 'Text Embedding Ada 002' },
];
const openAIModelOptions = [
  { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5', label: 'GPT-5' },
];
const reasoningEffortOptions: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const displayCurrencyOptions = [
  { value: 'USD', label: 'US dollar', rate: 1 },
  { value: 'INR', label: 'Indian rupee', rate: 83.5 },
  { value: 'GBP', label: 'British pound', rate: 0.79 },
  { value: 'EUR', label: 'Euro', rate: 0.92 },
] as const;

function supportsReasoningEffort(model: string) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function modelLabel(model?: string) {
  return openAIModelOptions.find((option) => option.value === model)?.label || model || 'OpenAI model';
}

function aiModelLabel(config: AppConfig) {
  return config.aiProvider === 'ollama'
    ? `Ollama ${config.ollamaModel || defaultOllamaModel}`
    : modelLabel(config.classificationModel);
}

function embeddingModelLabel(config: AppConfig) {
  return config.embeddingProvider === 'ollama'
    ? `Ollama ${config.ollamaEmbeddingModel || defaultOllamaEmbeddingModel}`
    : config.embeddingModel || defaultOpenAIEmbeddingModel;
}

function displayModel(model?: string) {
  return modelLabel(model || 'N/A');
}

function downloadJsonFile(fileName: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/[^\w.-]+/g, '_') || 'document-data.json';
  link.click();
  URL.revokeObjectURL(url);
}

function downloadBlobFile(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.replace(/[^\w.-]+/g, '_') || 'document';
  link.click();
  URL.revokeObjectURL(url);
}

function defaultTableColumns() {
  return [
    { key: 'description', label: 'Description', type: 'string' as FieldType, description: '' },
    { key: 'quantity', label: 'Quantity', type: 'number' as FieldType, description: '' },
    { key: 'amount', label: 'Amount', type: 'currency' as FieldType, description: '' },
  ];
}

function withUiIds(fields: ExtractionField[]) {
  return fields.map((field, index) => ({
    ...field,
    uiId: field.uiId || `${field.key || 'field'}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    columns: (field.columns || []).map((column, columnIndex) => ({
      ...column,
      key: column.key || `column_${columnIndex + 1}`,
    })),
  }));
}

function toKey(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function coerceValue(value: unknown) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function formatScore(score?: number) {
  return typeof score === 'number' ? `${Math.round(score * 100)}%` : 'N/A';
}

function isLowClassificationScore(score?: number) {
  return typeof score === 'number' && score < 0.8;
}

function scoreToneClass(score?: number) {
  if (isLowClassificationScore(score)) return ' low-score';
  if (typeof score === 'number' && score >= 0.8) return ' high-score';
  return '';
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatCurrency(value: number, currency: DisplayCurrency = 'USD') {
  const option = displayCurrencyOptions.find((item) => item.value === currency) || displayCurrencyOptions[0];
  const convertedValue = value * option.rate;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: option.value,
    minimumFractionDigits: convertedValue > 0 && convertedValue < 0.01 ? 4 : 2,
    maximumFractionDigits: convertedValue > 0 && convertedValue < 0.01 ? 6 : 2,
  }).format(convertedValue);
}

function normalizeDisplayCurrency(currency?: string | null): DisplayCurrency {
  return displayCurrencyOptions.some((option) => option.value === currency) ? currency as DisplayCurrency : 'USD';
}

function displaySampleName(fileName: string) {
  const parts = fileName.split('/');
  return parts[parts.length - 1] || fileName;
}

function ClassificationMethodIcon({
  method,
  onShowJustification,
}: {
  method?: IncomingDocument['classificationMethod'];
  onShowJustification?: () => void;
}) {
  if (method === 'vector') {
    return (
      <span
        className={`method-icon vector${onShowJustification ? ' interactive' : ''}`}
        title={onShowJustification ? 'Show vector classification results' : 'Vector classification'}
        aria-label={onShowJustification ? 'Show vector classification results' : 'Vector classification'}
        role={onShowJustification ? 'button' : undefined}
        tabIndex={onShowJustification ? 0 : undefined}
        onClick={onShowJustification ? (event) => {
          event.stopPropagation();
          onShowJustification();
        } : undefined}
        onKeyDown={onShowJustification ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onShowJustification();
          }
        } : undefined}
      >
        <Network size={14} />
      </span>
    );
  }
  if (method === 'llm' || method === 'rag') {
    const isRag = method === 'rag';
    const methodLabel = isRag ? 'RAG classification' : 'LLM classification';
    return (
      <span
        className={`method-icon ${method}${onShowJustification ? ' interactive' : ''}`}
        title={onShowJustification ? `Show ${methodLabel} justification` : methodLabel}
        aria-label={onShowJustification ? `Show ${methodLabel} justification` : methodLabel}
        role={onShowJustification ? 'button' : undefined}
        tabIndex={onShowJustification ? 0 : undefined}
        onClick={onShowJustification ? (event) => {
          event.stopPropagation();
          onShowJustification();
        } : undefined}
        onKeyDown={onShowJustification ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onShowJustification();
          }
        } : undefined}
      >
        {isRag ? <FileSearch size={14} /> : <BrainCircuit size={14} />}
      </span>
    );
  }
  return null;
}

function ClassificationJustificationDialog({
  document,
  onClose,
}: {
  document: IncomingDocument;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="classification-justification-title" onClick={onClose}>
      <section className="confirm-modal classification-justification-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <h2 id="classification-justification-title">Classification Justification</h2>
            <p>{document.originalName}</p>
          </div>
          <button className="icon-button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="classification-justification-summary">
          <span>Selected document type</span>
          <strong>{document.category} / {document.documentTypeName}</strong>
          <span>Model</span>
          <strong>{displayModel(document.classificationModel)}</strong>
          <span>Justification</span>
          <p>{document.classificationJustification || 'No justification was recorded for this previously processed document.'}</p>
          {(document.classificationMethod === 'rag' || document.classificationMethod === 'vector') && (
            <>
              <span>Retrieved types</span>
              {document.classificationCandidates?.length ? (
                <div className="rag-candidate-table-wrap">
                  <table className="rag-candidate-table">
                    <thead>
                      <tr>
                        <th scope="col">Rank</th>
                        <th scope="col">Category</th>
                        <th scope="col">Document type</th>
                        <th scope="col">Vector score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {document.classificationCandidates.map((candidate, index) => (
                        <tr key={candidate.documentTypeId}>
                          <td>{index + 1}</td>
                          <td>{candidate.category}</td>
                          <td>{candidate.name}</td>
                          <td>{(candidate.score * 100).toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No vector retrieval scores were recorded for this previously processed document.</p>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function ProcessingModeIcon({ mode }: { mode?: IncomingDocument['processingMode'] }) {
  if (mode === 'ocr') {
    return (
      <span className="processing-mode-icon ocr" title="Processed using OCR text" aria-label="Processed using OCR text">
        <ScanText size={14} />
      </span>
    );
  }
  if (mode === 'pdf') {
    return (
      <span className="processing-mode-icon pdf" title="Processed using PDF file" aria-label="Processed using PDF file">
        <FileText size={14} />
      </span>
    );
  }
  if (mode === 'markdown') {
    return (
      <span className="processing-mode-icon markdown" title="Processed using markdown" aria-label="Processed using markdown">
        <FileText size={14} />
      </span>
    );
  }
  return null;
}

function DocumentFileTypeIcon({ document }: { document: IncomingDocument }) {
  const mimeType = (document.mimeType || '').toLowerCase();
  const extension = document.originalName.split('.').pop()?.toLowerCase() || '';
  if (mimeType === 'application/pdf' || extension === 'pdf') {
    return <span className="document-file-type pdf" title="PDF document"><FileText size={19} /><small>PDF</small></span>;
  }
  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff'].includes(extension)) {
    return <span className="document-file-type image" title="Image document"><FileImage size={19} /><small>IMG</small></span>;
  }
  if (
    mimeType.includes('spreadsheet')
    || mimeType.includes('excel')
    || ['csv', 'xls', 'xlsx'].includes(extension)
  ) {
    return <span className="document-file-type spreadsheet" title="Spreadsheet document"><FileSpreadsheet size={19} /><small>SHEET</small></span>;
  }
  return <span className="document-file-type generic" title={extension ? `${extension.toUpperCase()} document` : 'Document'}><GenericFileIcon size={19} /><small>{extension ? extension.slice(0, 5).toUpperCase() : 'FILE'}</small></span>;
}

function OpenAIModelControls({
  model,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange,
}: {
  model: string;
  reasoningEffort: ReasoningEffort;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
}) {
  const hasReasoning = supportsReasoningEffort(model);

  return (
    <div className="model-controls">
      <label>
        Model
        <select value={model} onChange={(event) => onModelChange(event.target.value)}>
          {openAIModelOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Reasoning effort
        <select
          value={reasoningEffort}
          disabled={!hasReasoning}
          onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort)}
        >
          {reasoningEffortOptions.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function asTableRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map((row) => (row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : { value: row }));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return asTableRows(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function tableColumns(rows: Record<string, unknown>[]) {
  return Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
}

function normalizedColumnName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function coerceRowsToColumns(value: unknown, columns: TableColumn[]) {
  if (!columns.length) return asTableRows(value);
  return asTableRows(value).map((row) => {
    const aliases = new Map<string, unknown>();
    Object.entries(row).forEach(([key, rowValue]) => {
      aliases.set(key, rowValue);
      aliases.set(normalizedColumnName(key), rowValue);
    });
    if (typeof row.key === 'string' && Object.prototype.hasOwnProperty.call(row, 'value')) {
      aliases.set(row.key, row.value);
      aliases.set(normalizedColumnName(row.key), row.value);
    }
    return Object.fromEntries(columns.map((column) => [
      column.key,
      aliases.get(column.key) ??
      aliases.get(normalizedColumnName(column.key)) ??
      aliases.get(normalizedColumnName(column.label)) ??
      '',
    ]));
  });
}

function normalizeExtractedDataToSchema(values: ExtractedValue[], documentType?: DocumentType) {
  if (!documentType) return values;
  const fieldsByKey = new Map(documentType.fields.map((field) => [field.key, field]));
  return values.map((item) => {
    const schemaField = fieldsByKey.get(item.key);
    if (item.type !== 'table' || !schemaField?.columns?.length) return item;
    return {
      ...item,
      value: coerceRowsToColumns(item.value, schemaField.columns),
    };
  });
}

function hasExtractedValue(item: ExtractedValue) {
  if (item.type === 'table') return asTableRows(item.value).length > 0;
  if (item.value === null || typeof item.value === 'undefined') return false;
  if (typeof item.value === 'string') return item.value.trim().length > 0;
  if (Array.isArray(item.value)) return item.value.length > 0;
  return true;
}

function confidenceBadge(item: ExtractedValue) {
  if (!hasExtractedValue(item)) return null;
  return typeof item.confidence === 'number' ? `${Math.round(item.confidence * 100)}%` : null;
}

export function App() {
  if (window.location.pathname === '/xtractor') {
    return <MarketingSite />;
  }

  return <OperationsApp />;
}

function OperationsApp() {
  const [view, setView] = useState<View>('documents');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [documents, setDocuments] = useState<IncomingDocument[]>([]);
  const [documentPage, setDocumentPage] = useState<PagedResult<IncomingDocument>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  });
  const [documentTypesLoaded, setDocumentTypesLoaded] = useState(false);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [metricsLoaded, setMetricsLoaded] = useState(false);
  const [activeTypeId, setActiveTypeId] = useState('');
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [documentListStatusTarget, setDocumentListStatusTarget] = useState<{
    status: DocumentStatusFilter;
    version: number;
  }>({ status: '', version: 0 });
  const documentPageRef = useRef(documentPage);
  const documentListStatusTargetRef = useRef(documentListStatusTarget);
  documentPageRef.current = documentPage;
  documentListStatusTargetRef.current = documentListStatusTarget;
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [loading, setLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>('USD');
  const [operationsMetrics, setOperationsMetrics] = useState<OperationsMetrics>({
    filesProcessed: 0,
    totalCostUsd: 0,
    filesProcessing: 0,
    filesReady: 0,
  });
  const [config, setConfig] = useState<AppConfig>({
    storageEncryptionEnabled: false,
    databaseEncryptionEnabled: false,
    storageEncryptionKeyConfigured: false,
    databaseEncryptionKeyConfigured: false,
    cachingEnabled: true,
    configurationCacheTtlSeconds: 30,
    turnstileEnabled: false,
    turnstileSiteKey: '',
    turnstileSecretKey: '',
    turnstileSecretKeyConfigured: false,
    turnstileExpectedHostname: '',
    turnstileExpectedAction: 'request-demo',
    downstreamUrl: '',
    deleteAfterDownstream: false,
    sendKeyValuePairs: false,
    useOcrForDocumentProcessing: false,
    documentTextMode: 'ocr',
    markdownServiceUrl: '',
    aiProvider: 'openai',
    llmEndpoint: '',
    apiKey: '',
    apiKeyConfigured: false,
    openAiApiKey: '',
    openAiApiKeyConfigured: false,
    customApiKey: '',
    customApiKeyConfigured: false,
    ollamaBaseUrl: defaultOllamaBaseUrl,
    ollamaModel: defaultOllamaModel,
    embeddingProvider: 'openai',
    embeddingModel: defaultOpenAIEmbeddingModel,
    ollamaEmbeddingModel: defaultOllamaEmbeddingModel,
    classificationModel: lowCostOpenAIModel,
    classificationReasoningEffort: 'low',
    classificationMode: 'vector',
    classificationRagTopK: 5,
    preprocessingConcurrency: 4,
    vectorClassificationConcurrency: 4,
    llmClassificationConcurrency: 1,
    extractionConcurrency: 1,
  });
  const isAdmin = currentUser?.role === 'admin';
  const canManageDocuments = currentUser?.role === 'admin' || currentUser?.role === 'validator';

  async function loadConfiguration() {
    try {
      const saved = await api.getConfiguration();
      setConfig({
        storageEncryptionEnabled: Boolean(saved.storageEncryptionEnabled),
        databaseEncryptionEnabled: Boolean(saved.databaseEncryptionEnabled),
        storageEncryptionKeyConfigured: Boolean(saved.storageEncryptionKeyConfigured),
        databaseEncryptionKeyConfigured: Boolean(saved.databaseEncryptionKeyConfigured),
        cachingEnabled: saved.cachingEnabled !== false,
        configurationCacheTtlSeconds: Math.min(86400, Math.max(1, Number(saved.configurationCacheTtlSeconds) || 30)),
        turnstileEnabled: Boolean(saved.turnstileEnabled),
        turnstileSiteKey: saved.turnstileSiteKey || '',
        turnstileSecretKey: '',
        turnstileSecretKeyConfigured: Boolean(saved.turnstileSecretKeyConfigured),
        turnstileExpectedHostname: saved.turnstileExpectedHostname || '',
        turnstileExpectedAction: saved.turnstileExpectedAction || 'request-demo',
        downstreamUrl: saved.downstreamUrl || '',
        deleteAfterDownstream: Boolean(saved.deleteAfterDownstream),
        sendKeyValuePairs: Boolean(saved.sendKeyValuePairs),
        useOcrForDocumentProcessing: Boolean(saved.useOcrForDocumentProcessing),
        documentTextMode: saved.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
        markdownServiceUrl: saved.markdownServiceUrl || '',
        aiProvider: saved.aiProvider === 'custom' || saved.aiProvider === 'ollama'
          ? saved.aiProvider
          : 'openai',
        llmEndpoint: saved.llmEndpoint || '',
        apiKey: '',
        apiKeyConfigured: Boolean(saved.apiKeyConfigured),
        openAiApiKey: '',
        openAiApiKeyConfigured: Boolean(saved.openAiApiKeyConfigured),
        customApiKey: '',
        customApiKeyConfigured: Boolean(saved.customApiKeyConfigured),
        ollamaBaseUrl: saved.ollamaBaseUrl || defaultOllamaBaseUrl,
        ollamaModel: saved.ollamaModel || defaultOllamaModel,
        embeddingProvider: saved.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
        embeddingModel: saved.embeddingModel || defaultOpenAIEmbeddingModel,
        ollamaEmbeddingModel: saved.ollamaEmbeddingModel || defaultOllamaEmbeddingModel,
        classificationModel: saved.classificationModel || lowCostOpenAIModel,
        classificationReasoningEffort: saved.classificationReasoningEffort || 'low',
        classificationMode: saved.classificationMode === 'llm' || saved.classificationMode === 'rag' ? saved.classificationMode : 'vector',
        classificationRagTopK: Math.min(50, Math.max(1, Number(saved.classificationRagTopK) || 5)),
        preprocessingConcurrency: Math.min(16, Math.max(1, Number(saved.preprocessingConcurrency) || 4)),
        vectorClassificationConcurrency: Math.min(16, Math.max(1, Number(saved.vectorClassificationConcurrency) || 4)),
        llmClassificationConcurrency: Math.min(16, Math.max(1, Number(saved.llmClassificationConcurrency) || 1)),
        extractionConcurrency: Math.min(16, Math.max(1, Number(saved.extractionConcurrency) || 1)),
      });
    } catch {
      const storedConfig = localStorage.getItem('xtract-config');
      if (storedConfig) {
        try {
          const parsed = JSON.parse(storedConfig);
          setConfig({
            storageEncryptionEnabled: Boolean(parsed.storageEncryptionEnabled),
            databaseEncryptionEnabled: Boolean(parsed.databaseEncryptionEnabled),
            storageEncryptionKeyConfigured: Boolean(parsed.storageEncryptionKeyConfigured),
            databaseEncryptionKeyConfigured: Boolean(parsed.databaseEncryptionKeyConfigured),
            cachingEnabled: parsed.cachingEnabled !== false,
            configurationCacheTtlSeconds: Math.min(86400, Math.max(1, Number(parsed.configurationCacheTtlSeconds) || 30)),
            turnstileEnabled: Boolean(parsed.turnstileEnabled),
            turnstileSiteKey: parsed.turnstileSiteKey || '',
            turnstileSecretKey: '',
            turnstileSecretKeyConfigured: Boolean(parsed.turnstileSecretKeyConfigured),
            turnstileExpectedHostname: parsed.turnstileExpectedHostname || '',
            turnstileExpectedAction: parsed.turnstileExpectedAction || 'request-demo',
            downstreamUrl: parsed.downstreamUrl || '',
            deleteAfterDownstream: Boolean(parsed.deleteAfterDownstream),
            sendKeyValuePairs: Boolean(parsed.sendKeyValuePairs),
            useOcrForDocumentProcessing: Boolean(parsed.useOcrForDocumentProcessing),
            documentTextMode: parsed.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
            markdownServiceUrl: parsed.markdownServiceUrl || '',
            aiProvider: ['openai', 'custom', 'ollama'].includes(parsed.aiProvider) ? parsed.aiProvider : 'openai',
            llmEndpoint: parsed.llmEndpoint || '',
            apiKey: '',
            apiKeyConfigured: Boolean(parsed.apiKeyConfigured),
            openAiApiKey: '',
            openAiApiKeyConfigured: Boolean(parsed.openAiApiKeyConfigured),
            customApiKey: '',
            customApiKeyConfigured: Boolean(parsed.customApiKeyConfigured),
            ollamaBaseUrl: parsed.ollamaBaseUrl || defaultOllamaBaseUrl,
            ollamaModel: parsed.ollamaModel || defaultOllamaModel,
            embeddingProvider: parsed.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
            embeddingModel: parsed.embeddingModel || defaultOpenAIEmbeddingModel,
            ollamaEmbeddingModel: parsed.ollamaEmbeddingModel || defaultOllamaEmbeddingModel,
            classificationModel: parsed.classificationModel || lowCostOpenAIModel,
            classificationReasoningEffort: parsed.classificationReasoningEffort || 'low',
            classificationMode: parsed.classificationMode === 'llm' || parsed.classificationMode === 'rag' ? parsed.classificationMode : 'vector',
            classificationRagTopK: Math.min(50, Math.max(1, Number(parsed.classificationRagTopK) || 5)),
            preprocessingConcurrency: Math.min(16, Math.max(1, Number(parsed.preprocessingConcurrency) || 4)),
            vectorClassificationConcurrency: Math.min(16, Math.max(1, Number(parsed.vectorClassificationConcurrency) || 4)),
            llmClassificationConcurrency: Math.min(16, Math.max(1, Number(parsed.llmClassificationConcurrency) || 1)),
            extractionConcurrency: Math.min(16, Math.max(1, Number(parsed.extractionConcurrency) || 1)),
          });
        } catch {
          // ignore invalid saved config
        }
      }
    } finally {
      setConfigLoaded(true);
    }
  }

  async function saveConfiguration(newConfig: AppConfig): Promise<AppConfig> {
    const saved = await api.saveConfiguration(newConfig);
    setConfig(saved);
    showToast('Configuration saved successfully', 'info');
    return saved;
  }

  const activeType = activeTypeId ? documentTypes.find((item) => item._id === activeTypeId) : undefined;
  const categories = useMemo(
    () => Array.from(new Set(documentTypes.map((item) => item.category))).sort(),
    [documentTypes],
  );

  async function refreshDocumentTypes() {
    const types = await api.listDocumentTypes();
    setDocumentTypes(types);
    setDocumentTypesLoaded(true);
  }

  async function refreshDocuments() {
    const currentPage = documentPageRef.current;
    const currentStatusTarget = documentListStatusTargetRef.current;
    const params = new URLSearchParams({
      sort: 'latest',
      page: String(currentPage.page),
      pageSize: String(currentPage.pageSize),
    });
    if (currentStatusTarget.status) params.set('status', currentStatusTarget.status);
    const docs = await api.listDocuments(params);
    setDocumentPage(docs);
    setDocuments(docs.items);
    setDocumentsLoaded(true);
    return docs;
  }

  async function refreshOperationsMetrics() {
    const [summary, readyDocuments] = await Promise.all([
      api.getBusinessReviewSummary(),
      api.listDocuments(
        new URLSearchParams({
          status: 'extracted',
          page: '1',
          pageSize: '5',
        }),
      ),
    ]);

    setOperationsMetrics({
      filesProcessed: summary.filesProcessed,
      totalCostUsd: summary.estimatedCostUsd,
      filesProcessing: summary.filesProcessing,
      filesReady: readyDocuments.total,
    });
    setMetricsLoaded(true);
  }

  async function loadDocumentsPage(page: number) {
    const docs = await api.listDocuments(
      new URLSearchParams({
        sort: 'latest',
        page: String(page),
        pageSize: String(documentPage.pageSize),
      }),
    );
    setDocumentPage(docs);
    setDocuments(docs.items);
    setDocumentsLoaded(true);
    return docs;
  }

  function openValidationDocument(documentId: string) {
    setActiveDocumentId(documentId);
    setView('validation');
  }

  async function findAdjacentDocument(currentId: string, direction: 'previous' | 'next') {
    const pageSize = documentPage.pageSize;
    let page = documentPage.page;
    let items = documents;
    let totalPages = documentPage.totalPages;

    for (let attempts = 0; attempts < Math.max(totalPages, 1); attempts += 1) {
      const currentIndex = items.findIndex((item) => item._id === currentId);
      if (currentIndex >= 0) {
        if (direction === 'previous') {
          if (currentIndex > 0) return { page, document: items[currentIndex - 1] };
          if (page <= 1) return null;
          const previousPage = await api.listDocuments(
            new URLSearchParams({ sort: 'latest', page: String(page - 1), pageSize: String(pageSize) }),
          );
          return { page: previousPage.page, document: previousPage.items.at(-1) };
        }

        if (currentIndex < items.length - 1) return { page, document: items[currentIndex + 1] };
        if (page >= totalPages) return null;
        const nextPage = await api.listDocuments(
          new URLSearchParams({ sort: 'latest', page: String(page + 1), pageSize: String(pageSize) }),
        );
        return { page: nextPage.page, document: nextPage.items[0] };
      }

      const nextSearchPage = attempts === 0 ? documentPage.page : attempts;
      const refreshed = await api.listDocuments(
        new URLSearchParams({ sort: 'latest', page: String(nextSearchPage), pageSize: String(pageSize) }),
      );
      page = refreshed.page;
      items = refreshed.items;
      totalPages = refreshed.totalPages;
    }

    return null;
  }

  function showToast(text: string, type: 'success' | 'error' | 'info' = 'info') {
    setToast({ text, type });
  }

  function openDocuments(status: DocumentStatusFilter = '') {
    setDocumentListStatusTarget((target) => ({
      status,
      version: target.version + 1,
    }));
    setDocumentsLoaded(false);
    setView('documents');
  }

  async function moveToNextDocument(currentId: string) {
    if (!currentId) {
      setView('documents');
      return;
    }

    const currentIndex = documents.findIndex((item) => item._id === currentId);
    if (currentIndex >= 0 && currentIndex < documents.length - 1) {
      setActiveDocumentId(documents[currentIndex + 1]._id);
      setView('validation');
      return;
    }

    if (documentPage.page < documentPage.totalPages) {
      const nextPage = await loadDocumentsPage(documentPage.page + 1);
      if (nextPage.items.length > 0) {
        setActiveDocumentId(nextPage.items[0]._id);
        setView('validation');
        return;
      }
    }

    const refreshed = await refreshDocuments();
    const refreshedIndex = refreshed.items.findIndex((item) => item._id === currentId);
    if (refreshedIndex >= 0 && refreshedIndex < refreshed.items.length - 1) {
      setActiveDocumentId(refreshed.items[refreshedIndex + 1]._id);
      setView('validation');
      return;
    }

    setView('documents');
  }

  async function moveToAdjacentDocument(currentId: string, direction: 'previous' | 'next') {
    if (!currentId) return false;

    const adjacent = await findAdjacentDocument(currentId, direction);
    if (!adjacent?.document) return false;

    openValidationDocument(adjacent.document._id);
    if (adjacent.page !== documentPage.page) {
      await loadDocumentsPage(adjacent.page);
    }
    return true;
  }

  useEffect(() => {
    const stored = localStorage.getItem('xtract-dark-mode');
    setDarkMode(stored === 'true');
    setSidebarCollapsed(localStorage.getItem('xtract-sidebar-collapsed') === 'true');
    setDisplayCurrency(normalizeDisplayCurrency(localStorage.getItem('xtract-display-currency')));
  }, []);

  useEffect(() => {
    api.me()
      .then((user) => {
        setCurrentUser(user);
        setDisplayCurrency(normalizeDisplayCurrency(user.preferredCurrency));
      })
      .catch(() => {
        clearAuthToken();
        setCurrentUser(null);
      })
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!currentUser) return;
    if (currentUser.role === 'validator' && !['documents', 'upload', 'validation', 'password-reset'].includes(view)) {
      setView('documents');
      return;
    }
  }, [currentUser?.id, view]);

  useEffect(() => {
    if (!currentUser) return;
    if (!isAdmin || metricsLoaded) return;
    refreshOperationsMetrics().catch((error) => showToast(error.message, 'error'));
  }, [currentUser?.id, isAdmin, metricsLoaded]);

  useEffect(() => {
    if (!currentUser || !canManageDocuments) return;
    let refreshTimer: number | undefined;
    const connection = createDocumentRealtimeConnection(
      currentUser.id,
      (event) => {
        setDocuments((items) => items.map((document) => {
          if (document._id !== event.documentId || Number(document.revision || 0) > event.revision) return document;
          return {
            ...document,
            status: event.status,
            revision: event.revision,
            updatedAt: event.updatedAt,
          };
        }));
        setDocumentPage((page) => ({
          ...page,
          items: page.items.map((document) => {
            if (document._id !== event.documentId || Number(document.revision || 0) > event.revision) return document;
            return {
              ...document,
              status: event.status,
              revision: event.revision,
              updatedAt: event.updatedAt,
            };
          }),
        }));
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          const refreshes: Array<Promise<unknown>> = [refreshDocuments()];
          if (isAdmin) refreshes.push(refreshOperationsMetrics());
          Promise.all(refreshes).catch((error) => {
            console.warn('Unable to silently refresh document status and summary.', error);
          });
        }, 300);
      },
      () => {
        const refreshes: Array<Promise<unknown>> = [refreshDocuments()];
        if (isAdmin) refreshes.push(refreshOperationsMetrics());
        Promise.all(refreshes).catch((error) => {
          console.warn('Unable to silently refresh documents after reconnecting.', error);
        });
      },
    );
    if (!connection) return;

    let stopped = false;
    let retryTimer: number | undefined;
    const startConnection = () => {
      connection.start().catch((error) => {
        if (stopped) return;
        console.warn('Document real-time connection could not be started. Retrying.', error);
        retryTimer = window.setTimeout(startConnection, 10000);
      });
    };
    startConnection();
    return () => {
      stopped = true;
      window.clearTimeout(refreshTimer);
      window.clearTimeout(retryTimer);
      connection.stop().catch(() => undefined);
    };
  }, [currentUser?.id, canManageDocuments, isAdmin]);

  useEffect(() => {
    if (!currentUser) return;

    const tasks: Array<Promise<unknown>> = [];
    const needsDocumentTypes = ['types', 'classification', 'upload', 'documents', 'validation'].includes(view);
    const needsConfiguration =
      view === 'configuration' ||
      view === 'classification' ||
      view === 'validation' ||
      (view === 'documents' && canManageDocuments);

    if (needsDocumentTypes && !documentTypesLoaded) tasks.push(refreshDocumentTypes());
    if (view === 'documents' && !documentsLoaded) tasks.push(refreshDocuments());
    if (needsConfiguration && !configLoaded) tasks.push(loadConfiguration());

    if (!tasks.length) return;
    Promise.all(tasks).catch((error) => showToast(error instanceof Error ? error.message : 'Failed to load page data.', 'error'));
  }, [
    currentUser?.id,
    view,
    canManageDocuments,
    documentTypesLoaded,
    documentsLoaded,
    configLoaded,
  ]);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    localStorage.setItem('xtract-dark-mode', String(darkMode));
  }, [darkMode]);

  useEffect(() => {
    const {
      apiKey: _apiKey,
      openAiApiKey: _openAiApiKey,
      customApiKey: _customApiKey,
      turnstileSecretKey: _turnstileSecretKey,
      ...safeConfig
    } = config;
    localStorage.setItem('xtract-config', JSON.stringify(safeConfig));
  }, [config]);

  useEffect(() => {
    localStorage.setItem('xtract-sidebar-collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('xtract-display-currency', displayCurrency);
  }, [displayCurrency]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function run(action: () => Promise<void>, success: string) {
    setLoading(true);
    setToast(null);
    try {
      await action();
      showToast(success, 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Something went wrong', 'error');
    } finally {
      setLoading(false);
    }
  }

  function acceptSession(session: { token: string; user: AuthUser }) {
    saveAuthToken(session.token);
    setCurrentUser(session.user);
    setDisplayCurrency(normalizeDisplayCurrency(session.user.preferredCurrency));
    setView('documents');
  }

  async function handleLogin(username: string, password: string) {
    const result = await api.login({ username, password });
    if ('requiresTwoFactor' in result || 'requiresTwoFactorSetup' in result) return result;
    acceptSession(result);
    return undefined;
  }

  async function handleTwoFactorLogin(twoFactorToken: string, code: string) {
    acceptSession(await api.verifyTwoFactorLogin({ twoFactorToken, code }));
  }

  async function handleRequiredTwoFactorSetup(twoFactorSetupToken: string, secret: string, code: string) {
    acceptSession(await api.completeRequiredTwoFactorSetup({ twoFactorSetupToken, secret, code }));
  }

  async function updateDisplayCurrency(currency: DisplayCurrency) {
    setDisplayCurrency(currency);
    try {
      const user = await api.updatePreferences({ preferredCurrency: currency });
      setCurrentUser(user);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Failed to save currency preference.', 'error');
    }
  }

  function logout() {
    clearAuthToken();
    setCurrentUser(null);
    setDocuments([]);
    setDocumentTypes([]);
    setDocumentTypesLoaded(false);
    setDocumentsLoaded(false);
    setConfigLoaded(false);
    setMetricsLoaded(false);
    setActiveDocumentId('');
    setView('documents');
  }

  const navigation = [
    { id: 'documents' as View, label: 'Documents', icon: Files },
    { id: 'upload' as View, label: 'Upload', icon: FilePlus2 },
    { id: 'types' as View, label: 'Document Types', icon: ClipboardCheck },
    { id: 'classification' as View, label: 'Classification', icon: BrainCircuit },
    { id: 'configuration' as View, label: 'Configuration', icon: Gauge },
    { id: 'business-review' as View, label: 'Business Review', icon: BarChart3 },
    { id: 'demo-requests' as View, label: 'Demo Requests', icon: Mail },
    { id: 'users' as View, label: 'User Management', icon: UsersIcon },
    { id: 'health' as View, label: 'Health Check', icon: Activity },
    { id: 'password-reset' as View, label: 'Password Reset', icon: KeyRound },
  ];
  const visibleNavigation = navigation.filter((item) => (
    currentUser?.role === 'admin'
      ? true
      : item.id === 'documents' || item.id === 'upload' || item.id === 'password-reset'
  ));
  const validationDocumentId = activeDocumentId || documents[0]?._id || '';
  const validationDocumentIndex = documents.findIndex((item) => item._id === validationDocumentId);
  const canNavigatePreviousDocument =
    Boolean(validationDocumentId) &&
    (documentPage.page > 1 || validationDocumentIndex > 0);
  const canNavigateNextDocument =
    Boolean(validationDocumentId) &&
    (documentPage.page < documentPage.totalPages ||
      (validationDocumentIndex >= 0 && validationDocumentIndex < documents.length - 1));
  const averageCostPerFile = operationsMetrics.filesProcessed
    ? operationsMetrics.totalCostUsd / operationsMetrics.filesProcessed
    : 0;
  const selectedPageLoading =
    (view === 'types' && !documentTypesLoaded) ||
    (view === 'classification' && (!documentTypesLoaded || !configLoaded)) ||
    (view === 'upload' && !documentTypesLoaded) ||
    (view === 'documents' && (!documentsLoaded || !documentTypesLoaded || (canManageDocuments && !configLoaded))) ||
    (view === 'validation' && (!documentTypesLoaded || !configLoaded)) ||
    (view === 'configuration' && !configLoaded);

  if (!authChecked) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <Loader2 size={24} className="spin" />
          <p>Checking session.</p>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        onVerifyTwoFactor={handleTwoFactorLogin}
        onCompleteTwoFactorSetup={handleRequiredTwoFactorSetup}
      />
    );
  }

  return (
    <main className={sidebarCollapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-mark" src="/icon-192.png" alt="" aria-hidden="true" />
          <div className="brand-copy">
            <strong>Xtract</strong>
            <span>Document intake</span>
          </div>
          <button
            type="button"
            className="icon-button sidebar-toggle"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
        <nav>
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={view === item.id ? 'nav-item active' : 'nav-item'}
                key={item.id}
                onClick={() => setView(item.id)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <span>{currentUser.username}</span>
          <strong>{currentUser.role}</strong>
          <button type="button" className="secondary-button compact" onClick={logout}>Logout</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Extraction operations</p>
            <h1>{view === 'validation' ? 'Validation' : navigation.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            {isAdmin && (
              <div className="status-strip">
                <StatusMetric label="Files processed" value={operationsMetrics.filesProcessed} />
                <StatusMetric
                  label="Total cost"
                  value={formatCurrency(operationsMetrics.totalCostUsd, displayCurrency)}
                  onClick={() => setView('business-review')}
                />
                <StatusMetric
                  label="Avg cost / file"
                  value={formatCurrency(averageCostPerFile, displayCurrency)}
                  onClick={() => setView('business-review')}
                />
                <StatusMetric
                  label="In progress"
                  value={operationsMetrics.filesProcessing}
                  onClick={() => openDocuments('in-progress')}
                />
                <StatusMetric
                  label="Extracted"
                  value={operationsMetrics.filesReady}
                  onClick={() => openDocuments('extracted')}
                />
              </div>
            )}
            <button
              type="button"
              className="icon-button theme-toggle"
              title={darkMode ? 'Disable dark mode' : 'Enable dark mode'}
              onClick={() => setDarkMode((current) => !current)}
            >
              {darkMode ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </header>

        <div className="toast-container">
          {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}
        </div>
        {loading && (
          <div className="loading-line">
            <Loader2 size={16} />
            Working
          </div>
        )}

        {selectedPageLoading && <EmptyState text="Loading page data." />}

        {!selectedPageLoading && isAdmin && view === 'types' && (
          <DocumentTypeManagement
            documentTypes={documentTypes}
            activeType={activeType}
            config={config}
            onConfigChange={setConfig}
            setActiveTypeId={setActiveTypeId}
            categories={categories}
            onRun={run}
            onRefresh={refreshDocumentTypes}
            onDocumentTypeSaved={(documentType) =>
              setDocumentTypes((items) => items.map((item) => (item._id === documentType._id ? documentType : item)))
            }
          />
        )}
        {!selectedPageLoading && isAdmin && view === 'classification' && (
          <ClassificationScreen
            documentTypes={documentTypes}
            config={config}
            onConfigChange={setConfig}
            onSaveConfig={saveConfiguration}
            onRun={run}
            onRefresh={refreshDocumentTypes}
          />
        )}
        {!selectedPageLoading && canManageDocuments && view === 'upload' && (
          <UploadScreen
            categories={categories}
            documentTypes={documentTypes}
            onRun={run}
            onRefresh={refreshDocumentTypes}
            openDocuments={() => openDocuments()}
          />
        )}
        {!selectedPageLoading && view === 'documents' && (
          <DocumentList
            documents={documents}
            documentTypes={documentTypes}
            pagination={documentPage}
            statusTarget={documentListStatusTarget}
            onStatusTargetApplied={() => {
              setDocumentListStatusTarget((target) => ({ ...target, version: 0 }));
            }}
            config={config}
            canManage={canManageDocuments}
            onOpen={(id) => {
              setActiveDocumentId(id);
              setView('validation');
            }}
            onPage={(page) => {
              setDocumentPage(page);
              setDocuments(page.items);
              setDocumentsLoaded(true);
            }}
          />
        )}
        {!selectedPageLoading && isAdmin && view === 'business-review' && (
          <BusinessReviewScreen
            displayCurrency={displayCurrency}
            onCurrencyChange={updateDisplayCurrency}
            onNotify={showToast}
          />
        )}
        {!selectedPageLoading && isAdmin && view === 'demo-requests' && (
          <DemoRequestsScreen
            config={config}
            onConfigChange={setConfig}
            onSaveConfig={saveConfiguration}
            onNotify={showToast}
          />
        )}
        {!selectedPageLoading && isAdmin && view === 'users' && (
          <UserManagementScreen currentUser={currentUser} onNotify={showToast} />
        )}
        {!selectedPageLoading && isAdmin && view === 'health' && (
          <HealthDashboard onNotify={showToast} />
        )}
        {!selectedPageLoading && view === 'password-reset' && (
          <PasswordResetScreen
            currentUser={currentUser}
            onUserChange={setCurrentUser}
            onNotify={showToast}
          />
        )}
        {!selectedPageLoading && view === 'validation' && (
          <ValidationScreen
            documentId={validationDocumentId}
            documentTypes={documentTypes}
            config={config}
            canNavigatePrevious={canNavigatePreviousDocument}
            canNavigateNext={canNavigateNextDocument}
            onNavigatePrevious={(currentDocumentId) => moveToAdjacentDocument(currentDocumentId, 'previous')}
            onNavigateNext={(currentDocumentId) => moveToAdjacentDocument(currentDocumentId, 'next')}
            onRefresh={refreshDocumentTypes}
            onValidated={async (_notification: string) => {
              await moveToNextDocument(validationDocumentId);
            }}
            onNotify={showToast}
            canAdminActions={canManageDocuments}
          />
        )}
        {!selectedPageLoading && isAdmin && view === 'configuration' && (
          <ConfigurationScreen
            config={config}
            onConfigChange={setConfig}
            onSave={saveConfiguration}
            onRefresh={loadConfiguration}
          />
        )}
      </section>
    </main>
  );
}

function StatusMetric({ label, value, onClick }: { label: string; value: number | string; onClick?: () => void }) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="metric metric-button" onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <div className="metric">
      {content}
    </div>
  );
}

function MarketingSite() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitDemoRequest(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      const settings = await api.getDemoRequestSettings();
      if (settings.turnstileEnabled && !settings.turnstileSiteKey) {
        throw new Error('Demo verification is temporarily unavailable. Please try again later.');
      }
      const turnstileToken = settings.turnstileEnabled
        ? await requestTurnstileToken(settings.turnstileSiteKey, settings.turnstileAction)
        : undefined;
      await api.createDemoRequest({ email, phone, website, turnstileToken });
      setEmail('');
      setPhone('');
      setWebsite('');
      setStatus({ type: 'success', text: 'Demo request received. We will contact you shortly.' });
    } catch (error) {
      setStatus({ type: 'error', text: error instanceof Error ? error.message : 'Failed to submit request.' });
    } finally {
      setSubmitting(false);
    }
  }

  function focusRequestForm() {
    document.getElementById('demo-request-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => document.getElementById('marketing-email')?.focus(), 350);
  }

  return (
    <main className="marketing-site">
      <section className="marketing-hero">
        <div className="marketing-nav">
          <div className="marketing-brand">
            <img src="/icon-192.png" alt="" />
            <strong>Xtractor</strong>
          </div>
          <div className="marketing-nav-links">
            <a href="#how-it-works">How it works</a>
            <a href="#business-applications">Solutions</a>
            <a href="#demo-request-form">Contact</a>
          </div>
          <div className="marketing-nav-actions">
            <button type="button" className="marketing-secondary-link" onClick={() => { window.location.href = '/'; }}>Sign in</button>
            <button type="button" className="marketing-nav-cta" onClick={focusRequestForm}>Book a demo</button>
          </div>
        </div>
        <div className="marketing-hero-content">
          <div className="marketing-copy">
            <span className="marketing-kicker"><Sparkles size={14} /> Intelligent document operations</span>
            <h1>From complex documents to <em>trusted data.</em></h1>
            <p>
              Xtractor classifies, extracts, and validates business documents—then delivers clean, structured data to the systems your teams already use.
            </p>
            <div className="marketing-actions">
              <button type="button" className="marketing-primary-button" onClick={focusRequestForm}>
                See Xtractor in action
                <ChevronRight size={18} />
              </button>
              <a className="marketing-text-link" href="#how-it-works">Explore the workflow</a>
            </div>
            <div className="marketing-proof-points">
              <span><CheckCircle2 size={15} /> Human-in-the-loop validation</span>
              <span><CheckCircle2 size={15} /> Flexible AI providers</span>
              <span><CheckCircle2 size={15} /> API-ready output</span>
            </div>
          </div>
          <div className="marketing-product-visual" aria-label="Xtractor workflow preview">
            <div className="visual-toolbar">
              <div><i /><i /><i /></div>
              <span>Document operations</span>
              <strong><span /> Live</strong>
            </div>
            <div className="visual-app">
              <div className="visual-app-nav">
                <span className="active"><Files size={15} /> Documents</span>
                <span><BrainCircuit size={15} /> Classification</span>
                <span><ClipboardCheck size={15} /> Validation</span>
              </div>
              <div className="visual-app-main">
                <div className="visual-app-heading">
                  <div><small>Processing queue</small><strong>12 documents</strong></div>
                  <span>Live updates</span>
                </div>
                <div className="visual-document-row">
                  <div className="visual-file-icon"><FileText size={20} /></div>
                  <div><strong>Invoice_0428.pdf</strong><small>Accounts Payable</small></div>
                  <span className="visual-status extracted">Extracted</span><em>96%</em>
                </div>
                <div className="visual-document-row">
                  <div className="visual-file-icon"><FileText size={20} /></div>
                  <div><strong>Policy_Renewal.pdf</strong><small>Insurance</small></div>
                  <span className="visual-status classified">Classified</span><em>92%</em>
                </div>
                <div className="visual-progress-card">
                  <div><span>Intake</span><span>Classify</span><span>Extract</span><span>Validate</span></div>
                  <div className="visual-progress-line"><i /><i /><i /><i /></div>
                </div>
              </div>
            </div>
            <div className="visual-float-card">
              <ShieldCheck size={20} />
              <div><strong>Validated output</strong><span>Ready for downstream delivery</span></div>
            </div>
          </div>
        </div>
        <div className="marketing-client-strip">
          <span>Built for document-heavy teams in</span>
          <div><strong>FINANCE</strong><strong>INSURANCE</strong><strong>OPERATIONS</strong><strong>COMPLIANCE</strong></div>
        </div>
      </section>

      <section className="marketing-outcomes" aria-label="Platform outcomes">
        <article><strong>3 modes</strong><span>Vector, LLM, and RAG classification</span></article>
        <article><strong>Live</strong><span>Real-time processing visibility</span></article>
        <article><strong>Flexible</strong><span>OpenAI or Self Hosted models</span></article>
        <article><strong>Ready</strong><span>Structured JSON for downstream systems</span></article>
      </section>

      <section className="marketing-automation-demo" aria-label="Animated Xtractor document workflow">
        <div className="marketing-automation-heading">
          <span><i /> Live automation</span>
          <strong>Watch a document move through Xtractor</strong>
        </div>
        <div className="marketing-animation-track">
          <div className="marketing-animation-line"><span /></div>
          <div className="marketing-moving-document" aria-hidden="true">
            <FileText size={18} />
            <span>PDF</span>
          </div>
          {[
            { icon: Upload, label: 'Received', detail: 'Document intake' },
            { icon: BrainCircuit, label: 'Classified', detail: 'Type identified' },
            { icon: ScanText, label: 'Extracted', detail: 'Fields captured' },
            { icon: Network, label: 'Delivered', detail: 'Sent downstream' },
          ].map(({ icon: Icon, label, detail }, index) => (
            <article className={`marketing-animation-stage stage-${index + 1}`} key={label}>
              <div><Icon size={20} /></div>
              <strong>{label}</strong>
              <span>{detail}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-section marketing-how" id="how-it-works">
        <div className="marketing-section-heading centered">
          <span className="marketing-kicker">One intelligent workflow</span>
          <h2>Every document, handled from intake to action.</h2>
          <p>Replace fragmented tools and manual handoffs with a transparent workflow your team can control.</p>
        </div>
        <div className="marketing-workflow-grid">
          {[
            { icon: Upload, step: '01', title: 'Receive', text: 'Upload PDFs or drop them into monitored storage for immediate processing.' },
            { icon: BrainCircuit, step: '02', title: 'Classify', text: 'Route documents accurately using vector search, LLM, or RAG classification.' },
            { icon: ScanText, step: '03', title: 'Extract', text: 'Generate OCR or markdown and capture the business fields that matter.' },
            { icon: ClipboardCheck, step: '04', title: 'Validate', text: 'Review low-confidence data against the source document before delivery.' },
          ].map(({ icon: Icon, step, title, text }) => (
            <article key={title}>
              <span className="marketing-step">{step}</span>
              <div className="marketing-workflow-icon"><Icon size={22} /></div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="marketing-section" id="business-applications">
        <div className="marketing-section-heading">
          <span className="marketing-kicker">Designed for real operations</span>
          <h2>Turn high-volume paperwork into business momentum.</h2>
          <p>Adapt extraction schemas, validation rules, and downstream delivery to the way your teams work.</p>
        </div>
        <div className="marketing-card-grid">
          <article>
            <div className="marketing-card-icon"><Building2 size={22} /></div>
            <span>FINANCE</span>
            <h3>Accelerate accounts payable</h3>
            <p>Capture invoice totals, vendor details, tax, due dates, and line items before sending clean data downstream.</p>
            <a href="#demo-request-form">Transform invoice intake <ChevronRight size={15} /></a>
          </article>
          <article>
            <div className="marketing-card-icon"><ShieldCheck size={22} /></div>
            <span>COMPLIANCE</span>
            <h3>Review with confidence</h3>
            <p>Validate extracted fields beside the original PDF and maintain clear visibility into every processing step.</p>
            <a href="#demo-request-form">Strengthen review workflows <ChevronRight size={15} /></a>
          </article>
          <article>
            <div className="marketing-card-icon"><Network size={22} /></div>
            <span>OPERATIONS</span>
            <h3>Connect every handoff</h3>
            <p>Deliver validated JSON to ERP, claims, workflow, and analytics systems without repetitive data entry.</p>
            <a href="#demo-request-form">Modernize document operations <ChevronRight size={15} /></a>
          </article>
        </div>
      </section>

      <section className="marketing-demo-band">
        <div>
          <span className="marketing-kicker">A better document workflow starts here</span>
          <h2>Bring us a document. We’ll show you what Xtractor can do.</h2>
          <p>Book a tailored walkthrough and see how classification, extraction, validation, and delivery fit your operation.</p>
          <div className="marketing-demo-points">
            <span><CheckCircle2 size={16} /> Tailored to your document types</span>
            <span><CheckCircle2 size={16} /> No commitment required</span>
          </div>
        </div>
        <form className="marketing-demo-form" id="demo-request-form" onSubmit={submitDemoRequest}>
          <div className="marketing-form-heading">
            <strong>Request your demo</strong>
            <span>We’ll get back to you shortly.</span>
          </div>
          <label>
            Work email
            <div className="marketing-input-wrap">
              <Mail size={16} />
              <input
                id="marketing-email"
                type="email"
                required
                placeholder="you@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </label>
          <label className="demo-request-honeypot" aria-hidden="true">
            Website
            <input
              type="text"
              name="website"
              autoComplete="off"
              tabIndex={-1}
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </label>
          <label>
            Phone <span>optional</span>
            <div className="marketing-input-wrap">
              <Phone size={16} />
              <input
                type="tel"
                placeholder="+1 555 0100"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          </label>
          <button className="marketing-primary-button" type="submit" disabled={submitting}>
            {submitting ? <Loader2 size={18} className="spin" /> : <Mail size={18} />}
            Request demo
          </button>
          {status && <div className={`marketing-form-status ${status.type}`}>{status.text}</div>}
          <small>By submitting, you agree to be contacted about Xtractor.</small>
        </form>
      </section>
      <footer className="marketing-footer">
        <div className="marketing-brand"><img src="/icon-192.png" alt="" /><strong>Xtractor</strong></div>
        <p>Intelligent document operations, built for trusted outcomes.</p>
        <button type="button" onClick={() => { window.location.href = '/'; }}>Sign in to Xtractor <ChevronRight size={15} /></button>
      </footer>
    </main>
  );
}

function LoginScreen({
  onLogin,
  onVerifyTwoFactor,
  onCompleteTwoFactorSetup,
}: {
  onLogin: (
    username: string,
    password: string,
  ) => Promise<
    | { requiresTwoFactor: true; twoFactorToken: string }
    | { requiresTwoFactorSetup: true; twoFactorSetupToken: string }
    | undefined
  >;
  onVerifyTwoFactor: (twoFactorToken: string, code: string) => Promise<void>;
  onCompleteTwoFactorSetup: (twoFactorSetupToken: string, secret: string, code: string) => Promise<void>;
}) {
  const rememberedUsername = localStorage.getItem('xtract-remembered-username') || '';
  const [username, setUsername] = useState(rememberedUsername);
  const [password, setPassword] = useState('');
  const [authenticationCode, setAuthenticationCode] = useState('');
  const [twoFactorToken, setTwoFactorToken] = useState('');
  const [requiredSetup, setRequiredSetup] = useState<{
    token: string;
    secret: string;
    qrCodeDataUrl: string;
  } | null>(null);
  const [rememberMe, setRememberMe] = useState(Boolean(rememberedUsername));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      if (requiredSetup) {
        await onCompleteTwoFactorSetup(requiredSetup.token, requiredSetup.secret, authenticationCode);
      } else if (twoFactorToken) {
        await onVerifyTwoFactor(twoFactorToken, authenticationCode);
      } else {
        const result = await onLogin(username, password);
        if (result && 'requiresTwoFactor' in result) {
          setTwoFactorToken(result.twoFactorToken);
          setPassword('');
          return;
        }
        if (result && 'requiresTwoFactorSetup' in result) {
          const setup = await api.beginRequiredTwoFactorSetup(result.twoFactorSetupToken);
          setRequiredSetup({
            token: result.twoFactorSetupToken,
            secret: setup.secret,
            qrCodeDataUrl: setup.qrCodeDataUrl,
          });
          setPassword('');
          return;
        }
      }
      if (rememberMe) {
        localStorage.setItem('xtract-remembered-username', username.trim());
      } else {
        localStorage.removeItem('xtract-remembered-username');
      }
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <img src="/icon-192.png" alt="" />
        <div>
          <h1>Sign in to Xtract</h1>
          <p>
            {requiredSetup
              ? 'Two-factor authentication is required. Register an authenticator app to continue.'
              : twoFactorToken
                ? 'Enter the code from your authenticator app.'
                : 'Use your assigned username and password.'}
          </p>
        </div>
        {requiredSetup ? (
          <div className="required-two-factor-setup">
            <p>Scan this QR code with your authenticator app.</p>
            <img src={requiredSetup.qrCodeDataUrl} alt="Authenticator setup QR code" />
            <details>
              <summary>Can’t scan the QR code?</summary>
              <code>{requiredSetup.secret}</code>
            </details>
            <label>
              Authentication code
              <input
                value={authenticationCode}
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                onChange={(event) => setAuthenticationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
          </div>
        ) : twoFactorToken ? (
          <label>
            Authentication code
            <input
              value={authenticationCode}
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              onChange={(event) => setAuthenticationCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
        ) : (
          <>
            <label>
              Username
              <input value={username} autoFocus onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label className="checkbox-row auth-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
              />
              <span>Remember me</span>
            </label>
          </>
        )}
        {error && <div className="auth-error">{error}</div>}
        <button
          className="primary-button"
          type="submit"
          disabled={submitting || (twoFactorToken || requiredSetup ? authenticationCode.length !== 6 : !username || !password)}
        >
          {submitting ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
          {requiredSetup ? 'Register and continue' : twoFactorToken ? 'Verify code' : 'Login'}
        </button>
        {(twoFactorToken || requiredSetup) && (
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              setTwoFactorToken('');
              setRequiredSetup(null);
              setAuthenticationCode('');
              setError('');
            }}
          >
            Back to login
          </button>
        )}
      </form>
    </main>
  );
}

function PasswordResetScreen({
  currentUser,
  onUserChange,
  onNotify,
}: {
  currentUser: AuthUser;
  onUserChange: (user: AuthUser) => void;
  onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [twoFactorSetup, setTwoFactorSetup] = useState<{ secret: string; qrCodeDataUrl: string } | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [twoFactorSaving, setTwoFactorSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      onNotify('New passwords do not match.', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onNotify('Password changed successfully.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to change password.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function startTwoFactorSetup() {
    setTwoFactorSaving(true);
    try {
      setTwoFactorSetup(await api.beginTwoFactorSetup());
      setTwoFactorCode('');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to start two-factor setup.', 'error');
    } finally {
      setTwoFactorSaving(false);
    }
  }

  async function enableTwoFactor() {
    if (!twoFactorSetup) return;
    setTwoFactorSaving(true);
    try {
      await api.enableTwoFactor({ secret: twoFactorSetup.secret, code: twoFactorCode });
      onUserChange({ ...currentUser, twoFactorEnabled: true });
      setTwoFactorSetup(null);
      setTwoFactorCode('');
      onNotify('Two-factor authentication enabled.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to enable two-factor authentication.', 'error');
    } finally {
      setTwoFactorSaving(false);
    }
  }

  return (
    <section className="panel narrow-panel password-reset-card">
      <div className="panel-heading">
        <div className="password-reset-heading">
          <span><KeyRound size={21} /></span>
          <div>
            <small>Account security</small>
            <h2>Password Reset</h2>
            <p>Change the password used to access your account.</p>
          </div>
        </div>
      </div>
      <div className="password-security-note">
        <ShieldCheck size={18} />
        <span>
          <strong>Keep your account secure</strong>
          <small>Use a strong password that is different from passwords used elsewhere.</small>
        </span>
      </div>
      <form className="form-grid password-reset-form" onSubmit={submit}>
        <label className="full-label">
          Current password
          <input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label className="full-label">
          New password
          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        <label className="full-label">
          Confirm new password
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        <div className="configuration-actions full-label">
          <button className="primary-button" type="submit" disabled={saving || !currentPassword || !newPassword || !confirmPassword}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
            Save password
          </button>
        </div>
      </form>
      <div className="two-factor-settings">
        <div className="two-factor-heading">
          <div>
            <h3>Authenticator app</h3>
            <p>Require a six-digit code when signing in.</p>
          </div>
          <span className={currentUser.twoFactorEnabled ? 'two-factor-status enabled' : 'two-factor-status'}>
            {currentUser.twoFactorEnabled ? <CheckCircle2 size={16} /> : <CircleHelp size={16} />}
            {currentUser.twoFactorEnabled ? 'Enabled' : 'Not enabled'}
          </span>
        </div>
        {!currentUser.twoFactorEnabled && !twoFactorSetup && (
          <button className="secondary-button" type="button" disabled={twoFactorSaving} onClick={startTwoFactorSetup}>
            {twoFactorSaving ? <Loader2 size={16} className="spin" /> : <ShieldCheck size={16} />}
            Set up authenticator
          </button>
        )}
        {!currentUser.twoFactorEnabled && twoFactorSetup && (
          <div className="two-factor-enrollment">
            <p>Scan this QR code with Google Authenticator, Microsoft Authenticator, Authy, or another TOTP app.</p>
            <img src={twoFactorSetup.qrCodeDataUrl} alt="Authenticator setup QR code" />
            <details>
              <summary>Can’t scan the QR code?</summary>
              <code>{twoFactorSetup.secret}</code>
            </details>
            <label>
              Enter the six-digit code to confirm
              <input
                value={twoFactorCode}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                onChange={(event) => setTwoFactorCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
            <div className="configuration-actions">
              <button className="primary-button" type="button" disabled={twoFactorSaving || twoFactorCode.length !== 6} onClick={enableTwoFactor}>
                {twoFactorSaving ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
                Enable 2FA
              </button>
              <button className="secondary-button" type="button" onClick={() => setTwoFactorSetup(null)}>Cancel</button>
            </div>
          </div>
        )}
        {currentUser.twoFactorEnabled && (
          <p className="help-text">Two-factor authentication is required for every Xtract account.</p>
        )}
      </div>
    </section>
  );
}

function UserManagementScreen({
  currentUser,
  onNotify,
}: {
  currentUser: AuthUser;
  onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('validator');
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetPasswordConfirmation, setResetPasswordConfirmation] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all');
  const [roleFilter, setRoleFilter] = useState<UserRoleFilter>('all');
  const [userSearch, setUserSearch] = useState('');

  async function loadUsers() {
    setLoadingUsers(true);
    try {
      setUsers(await api.listUsers());
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to load users.', 'error');
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []);

  function userId(user: AuthUser) {
    return user.id || user._id || '';
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setCreatingUser(true);
    try {
      await api.createUser({ username: newUsername, password: newPassword, role: newRole });
      setNewUsername('');
      setNewPassword('');
      setNewRole('validator');
      setShowCreateUser(false);
      onNotify('User created.', 'success');
      await loadUsers();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to create user.', 'error');
    } finally {
      setCreatingUser(false);
    }
  }

  function closeCreateUser() {
    if (creatingUser) return;
    setShowCreateUser(false);
    setNewUsername('');
    setNewPassword('');
    setNewRole('validator');
  }

  async function updateUser(user: AuthUser, payload: { role?: UserRole; enabled?: boolean }) {
    const id = userId(user);
    if (!id) return;
    try {
      await api.updateUser(id, payload);
      onNotify('User updated.', 'success');
      await loadUsers();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to update user.', 'error');
    }
  }

  async function confirmResetPassword() {
    if (!resetTarget) return;
    if (!resetPassword || resetPassword !== resetPasswordConfirmation) return;
    const id = userId(resetTarget);
    if (!id) return;
    try {
      await api.resetUserPassword(id, resetPassword);
      setResetTarget(null);
      setResetPassword('');
      setResetPasswordConfirmation('');
      onNotify('Password reset.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to reset password.', 'error');
    }
  }

  async function confirmDeleteUser() {
    if (!deleteTarget) return;
    const id = userId(deleteTarget);
    if (!id) return;
    try {
      await api.deleteUser(id);
      setDeleteTarget(null);
      onNotify('User removed.', 'success');
      await loadUsers();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to remove user.', 'error');
    }
  }

  const enabledUsers = users.filter((user) => user.enabled).length;
  const inactiveUsers = users.length - enabledUsers;
  const adminUsers = users.filter((user) => user.role === 'admin').length;
  const validatorUsers = users.length - adminUsers;
  const normalizedSearch = userSearch.trim().toLowerCase();
  const filteredUsers = users.filter((user) => {
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'active' && user.enabled)
      || (statusFilter === 'inactive' && !user.enabled);
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    return matchesStatus && matchesRole && (!normalizedSearch || user.username.toLowerCase().includes(normalizedSearch));
  });

  return (
    <div className="user-management">
      <section className="panel user-management-overview">
        <div className="panel-heading">
          <div className="user-management-heading">
            <span><UsersIcon size={21} /></span>
            <div>
              <small>Access administration</small>
              <h2>User Management</h2>
              <p>Add users, assign roles, and control access.</p>
            </div>
          </div>
          <div className="user-management-actions">
            <button className="icon-button user-add-button" type="button" title="Add user" aria-label="Add user" onClick={() => setShowCreateUser(true)}>
              <Plus size={18} />
            </button>
            <button className="icon-button" title="Refresh users" onClick={loadUsers}>
              {loadingUsers ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            </button>
          </div>
        </div>
      </section>
      <section className="panel user-directory-card">
        <div className="user-directory-heading">
          <div>
            <strong>User Directory</strong>
            <small>Manage account roles, status, passwords, and access.</small>
          </div>
          <span>{filteredUsers.length} of {users.length} account{users.length === 1 ? '' : 's'}</span>
        </div>
        <div className="user-directory-toolbar">
          <div className="user-directory-filter-groups">
            <div className="user-filter-group">
              <small>Status</small>
              <div className="user-filter-tabs" role="group" aria-label="Filter users by status">
                {([
                  ['all', 'All', users.length],
                  ['active', 'Active', enabledUsers],
                  ['inactive', 'Inactive', inactiveUsers],
                ] as const).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    className={statusFilter === value ? 'active' : ''}
                    aria-pressed={statusFilter === value}
                    onClick={() => setStatusFilter(value)}
                  >
                    {label}<span>{count}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="user-filter-group">
              <small>Role</small>
              <div className="user-filter-tabs" role="group" aria-label="Filter users by role">
                {([
                  ['all', 'All roles', users.length],
                  ['admin', 'Admin', adminUsers],
                  ['validator', 'Validator', validatorUsers],
                ] as const).map(([value, label, count]) => (
                  <button
                    key={value}
                    type="button"
                    className={roleFilter === value ? 'active' : ''}
                    aria-pressed={roleFilter === value}
                    onClick={() => setRoleFilter(value)}
                  >
                    {label}<span>{count}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <label className="user-search">
            <Search size={15} />
            <input
              type="search"
              value={userSearch}
              placeholder="Search users"
              aria-label="Search users"
              onChange={(event) => setUserSearch(event.target.value)}
            />
          </label>
        </div>
        <div className="business-review-table user-directory-table">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>2FA</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredUsers.map((user) => {
                const id = userId(user);
                const isSelf = id === currentUser.id;
                return (
                  <tr key={id || user.username}>
                    <td>
                      <span className="user-identity">
                        <span>{user.username.slice(0, 1).toUpperCase()}</span>
                        <strong>{user.username}{isSelf ? ' (you)' : ''}</strong>
                      </span>
                    </td>
                    <td>
                      <select
                        value={user.role}
                        disabled={isSelf}
                        onChange={(event) => updateUser(user, { role: event.target.value as UserRole })}
                      >
                        <option value="validator">Validator</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td><span className={user.enabled ? 'user-status enabled' : 'user-status disabled'}>{user.enabled ? 'Active' : 'Inactive'}</span></td>
                    <td>
                      <span className={user.twoFactorEnabled ? 'user-2fa enabled' : 'user-2fa disabled'}>
                        {user.twoFactorEnabled ? <ShieldCheck size={13} /> : <CircleHelp size={13} />}
                        {user.twoFactorEnabled ? 'Configured' : 'Not configured'}
                      </span>
                    </td>
                    <td>{user.createdAt ? new Date(user.createdAt).toLocaleString() : 'N/A'}</td>
                    <td>
                      <div className="table-actions">
                        <button className="secondary-button compact" type="button" onClick={() => {
                          setResetTarget(user);
                          setResetPassword('');
                          setResetPasswordConfirmation('');
                        }}>
                          Reset password
                        </button>
                        <button
                          className="secondary-button compact"
                          type="button"
                          disabled={isSelf}
                          onClick={() => updateUser(user, { enabled: !user.enabled })}
                        >
                          {user.enabled ? 'Deactivate' : 'Activate'}
                        </button>
                        <button
                          className="secondary-button compact danger-outline"
                          type="button"
                          disabled={isSelf}
                          onClick={() => setDeleteTarget(user)}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filteredUsers.length && (
            <div className="empty-table">
              {loadingUsers ? 'Loading users.' : users.length ? 'No users match these filters.' : 'No users found.'}
            </div>
          )}
        </div>
      </section>
      {showCreateUser && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="create-user-title">
          <form className="confirm-modal user-create-modal" onSubmit={createUser}>
            <div className="modal-heading">
              <div>
                <h2 id="create-user-title">Add new user</h2>
                <p>Create an account and choose its initial access role.</p>
              </div>
              <button className="icon-button" type="button" title="Close" onClick={closeCreateUser} disabled={creatingUser}>
                <X size={17} />
              </button>
            </div>
            <div className="user-create-form">
              <label>
                Username
                <input autoFocus autoComplete="username" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
              </label>
              <label>
                Initial password
                <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </label>
              <label>
                Role
                <select value={newRole} onChange={(event) => setNewRole(event.target.value as UserRole)}>
                  <option value="validator">Validator</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <div className="modal-footer">
              <button className="secondary-button" type="button" onClick={closeCreateUser} disabled={creatingUser}>Cancel</button>
              <button className="primary-button" type="submit" disabled={creatingUser || !newUsername.trim() || !newPassword}>
                {creatingUser ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                {creatingUser ? 'Adding user…' : 'Add user'}
              </button>
            </div>
          </form>
        </div>
      )}
      {resetTarget && (
        <ConfirmDialog
          title="Reset Password"
          body={
            <div className="reset-password-fields">
              <label>
                New password for {resetTarget.username}
                <input type="password" autoComplete="new-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
              </label>
              <label>
                Confirm new password
                <input
                  type="password"
                  autoComplete="new-password"
                  className={resetPasswordConfirmation && resetPassword !== resetPasswordConfirmation ? 'input-error' : ''}
                  value={resetPasswordConfirmation}
                  onChange={(event) => setResetPasswordConfirmation(event.target.value)}
                />
              </label>
              {resetPasswordConfirmation && resetPassword !== resetPasswordConfirmation && (
                <span className="field-error">Passwords do not match.</span>
              )}
            </div>
          }
          confirmLabel="Reset"
          confirmIcon={<KeyRound size={16} />}
          confirmDisabled={!resetPassword || resetPassword !== resetPasswordConfirmation}
          onCancel={() => {
            setResetTarget(null);
            setResetPassword('');
            setResetPasswordConfirmation('');
          }}
          onConfirm={confirmResetPassword}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title="Remove User"
          body={`Remove "${deleteTarget.username}"?`}
          confirmLabel="Remove"
          confirmIcon={<Trash2 size={16} />}
          isDanger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDeleteUser}
        />
      )}
    </div>
  );
}

function HealthDashboard({
  onNotify,
}: {
  onNotify: (message: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [health, setHealth] = useState<HealthCheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const groups: HealthCheckResult['checks'][number]['group'][] = [
    'Application',
    'Data',
    'Storage',
    'Queues',
    'Services',
    'AI',
  ];

  async function refresh() {
    setChecking(true);
    try {
      setHealth(await api.getHealth());
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Health check failed', 'error');
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <section className="health-dashboard">
      <div className="panel health-overview">
        <div className="panel-heading">
          <div className="health-overview-heading">
            <span><Activity size={20} /></span>
            <div>
              <small>Infrastructure status</small>
              <h2>System health</h2>
              <p>
                {health
                  ? `Last checked ${new Date(health.checkedAt).toLocaleString()}`
                  : 'Checking application resources.'}
              </p>
            </div>
          </div>
          <button className="secondary-button compact" onClick={() => refresh()} disabled={checking}>
            {checking ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            Check now
          </button>
        </div>
        {health && (
          <div className="health-summary">
            <div className={health.status === 'ready' ? 'ready' : 'unavailable'}>
              {health.status === 'ready' ? <CheckCircle2 size={22} /> : <CircleX size={22} />}
              <span>Overall</span>
              <strong>{health.status}</strong>
            </div>
            <div className="ready">
              <CheckCircle2 size={22} />
              <span>Ready</span>
              <strong>{health.summary.ready}</strong>
            </div>
            <div className="unavailable">
              <CircleX size={22} />
              <span>Unavailable</span>
              <strong>{health.summary.unavailable}</strong>
            </div>
            <div className="not-configured">
              <CircleHelp size={22} />
              <span>Not configured</span>
              <strong>{health.summary.notConfigured}</strong>
            </div>
          </div>
        )}
        {health && health.summary.unavailable > 0 && (
          <div className="health-degraded-list" role="alert">
            <div className="health-degraded-heading">
              <CircleX size={18} />
              <strong>Degraded resources</strong>
              <span>{health.summary.unavailable}</span>
            </div>
            <div>
              {health.checks
                .filter((check) => check.status === 'unavailable')
                .map((check) => (
                  <article key={check.id}>
                    <strong>{check.name}</strong>
                    <span>{check.detail}</span>
                  </article>
                ))}
            </div>
          </div>
        )}
      </div>

      {!health && checking && <EmptyState text="Checking system resources." />}

      {health && groups.map((group) => {
        const checks = health.checks.filter((check) => check.group === group);
        if (!checks.length) return null;
        return (
          <section className="panel health-group" key={group}>
            <div className="health-group-heading">
              <h3>{group}</h3>
              <span>{checks.filter((check) => check.status === 'ready').length} / {checks.length} ready</span>
            </div>
            <div className="health-resource-grid">
              {checks.map((check) => (
                <article className={`health-resource ${check.status}`} key={check.id}>
                  <div className="health-resource-icon">
                    {check.status === 'ready'
                      ? <CheckCircle2 size={20} />
                      : check.status === 'unavailable'
                        ? <CircleX size={20} />
                        : <CircleHelp size={20} />}
                  </div>
                  <div>
                    <div className="health-resource-heading">
                      <strong>{check.name}</strong>
                      <span>{check.status.replace('_', ' ')}</span>
                    </div>
                    <p>{check.detail}</p>
                    <small>{check.latencyMs ? `${check.latencyMs} ms response time` : 'No latency recorded'}</small>
                  </div>
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </section>
  );
}

function DemoRequestsScreen({
  config,
  onConfigChange,
  onSaveConfig,
  onNotify,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onSaveConfig: (config: AppConfig) => Promise<AppConfig>;
  onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [savingProtection, setSavingProtection] = useState(false);
  const [activeTab, setActiveTab] = useState<'requests' | 'settings'>('requests');

  async function loadRequests() {
    setLoadingRequests(true);
    try {
      setRequests(await api.listDemoRequests());
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to load demo requests', 'error');
    } finally {
      setLoadingRequests(false);
    }
  }

  async function saveProtection() {
    setSavingProtection(true);
    try {
      await onSaveConfig(config);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to save demo request protection', 'error');
    } finally {
      setSavingProtection(false);
    }
  }

  useEffect(() => {
    loadRequests();
  }, []);

  const sourceCount = new Set(requests.map((request) => request.source).filter(Boolean)).size;
  const latestRequest = requests
    .map((request) => new Date(request.createdAt))
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return (
    <div className="demo-requests-page">
      <section className="panel demo-requests-overview">
        <div className="panel-heading">
          <div className="demo-requests-heading">
            <span><Mail size={21} /></span>
            <div>
              <small>Sales pipeline</small>
              <h2>Demo Requests</h2>
              <p>Potential clients who requested a walkthrough from the Xtractor marketing site.</p>
            </div>
          </div>
          {activeTab === 'requests' && (
            <button className="icon-button" title="Refresh demo requests" onClick={loadRequests}>
              {loadingRequests ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            </button>
          )}
        </div>
        <div className="demo-request-tabs" role="tablist" aria-label="Demo requests">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'requests'}
            className={activeTab === 'requests' ? 'active' : ''}
            onClick={() => setActiveTab('requests')}
          >
            <Mail size={15} /> Requests
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'settings'}
            className={activeTab === 'settings' ? 'active' : ''}
            onClick={() => setActiveTab('settings')}
          >
            <ShieldCheck size={15} /> Settings
          </button>
        </div>
        {activeTab === 'requests' && (
          <div className="demo-request-summary">
            <div><Mail size={17} /><span>Total requests<strong>{requests.length}</strong></span></div>
            <div><TrendingUp size={17} /><span>Lead sources<strong>{sourceCount}</strong></span></div>
            <div><Clock3 size={17} /><span>Latest request<strong>{latestRequest ? latestRequest.toLocaleDateString() : '—'}</strong></span></div>
          </div>
        )}
      </section>

      {activeTab === 'settings' && <section className="panel demo-request-protection">
        <div className="demo-requests-list-heading">
          <div>
            <strong><ShieldCheck size={17} /> Demo request protection</strong>
            <small>Configure Cloudflare Turnstile for the public request form.</small>
          </div>
          <button className="primary-button compact" type="button" disabled={savingProtection} onClick={saveProtection}>
            {savingProtection ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
            Save protection
          </button>
        </div>
        <div className="turnstile-settings">
          <label className="turnstile-toggle-card">
            <input
              type="checkbox"
              checked={config.turnstileEnabled}
              onChange={(event) => onConfigChange({ ...config, turnstileEnabled: event.target.checked })}
            />
            <span>
              <strong>Enable Turnstile verification</strong>
              <small>When enabled, demo submissions fail closed unless Cloudflare validates the visitor.</small>
            </span>
          </label>
          <label>
            Site key
            <input
              type="text"
              value={config.turnstileSiteKey}
              onChange={(event) => onConfigChange({ ...config, turnstileSiteKey: event.target.value })}
              placeholder="Public Turnstile site key"
            />
          </label>
          <label>
            <span className="configuration-field-label">
              Secret key
              {config.turnstileSecretKeyConfigured && (
                <CheckCircle2 className="configuration-configured-icon" size={17} aria-label="Secret key configured" />
              )}
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={config.turnstileSecretKey}
              onChange={(event) => onConfigChange({ ...config, turnstileSecretKey: event.target.value })}
              placeholder={config.turnstileSecretKeyConfigured ? 'Secret configured — enter a new value to replace it' : 'Private Turnstile secret key'}
            />
          </label>
          <label>
            Expected hostname
            <input
              type="text"
              value={config.turnstileExpectedHostname}
              onChange={(event) => onConfigChange({ ...config, turnstileExpectedHostname: event.target.value })}
              placeholder="xtract.example.com"
            />
          </label>
          <label>
            Expected action
            <input
              type="text"
              value={config.turnstileExpectedAction}
              onChange={(event) => onConfigChange({ ...config, turnstileExpectedAction: event.target.value })}
              placeholder="request-demo"
            />
          </label>
          <p className="help-text">The site key is public. The secret is encrypted in MongoDB and is never returned to the browser.</p>
        </div>
      </section>}

      {activeTab === 'requests' && <section className="panel demo-requests-list">
        <div className="demo-requests-list-heading">
          <div>
            <strong>Request inbox</strong>
            <small>Contact details and acquisition source for every demo lead.</small>
          </div>
          <span>{requests.length} lead{requests.length === 1 ? '' : 's'}</span>
        </div>
        <div className="business-review-table demo-requests-table">
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Phone</th>
              <th>Source</th>
              <th>Requested</th>
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => (
              <tr key={request._id}>
                <td><span className="demo-contact"><Mail size={14} />{request.email}</span></td>
                <td><span className="demo-contact"><Phone size={14} />{request.phone || 'N/A'}</span></td>
                <td><span className="demo-source-pill">{request.source}</span></td>
                <td>{new Date(request.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!requests.length && (
          <div className="empty-table">
            {loadingRequests ? 'Loading demo requests.' : 'No demo requests yet.'}
          </div>
        )}
        </div>
      </section>}
      </div>
  );
}

function ReviewMetric({ label, value, helper }: { label: string; value: string; helper?: string }) {
  return (
    <div className="review-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {helper && <small>{helper}</small>}
    </div>
  );
}

function MonthlyCostProjectionChart({
  averageCostPerDocument,
  formatReviewCurrency,
}: {
  averageCostPerDocument: number;
  formatReviewCurrency: (value: number) => string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maxFiles = 1_000_000;
  const projectedCost = maxFiles * averageCostPerDocument;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const styles = getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue('--primary').trim() || '#4f46e5';
    const muted = styles.getPropertyValue('--muted').trim() || '#64748b';
    const border = styles.getPropertyValue('--border').trim() || '#e2e8f0';
    const surface = styles.getPropertyValue('--surface').trim() || '#ffffff';
    const volumePoints = Array.from({ length: 21 }, (_item, index) => index * 50_000);
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Projected cost',
            data: volumePoints.map((files) => ({
              x: files,
              y: files * averageCostPerDocument,
            })),
            borderColor: primary,
            backgroundColor: 'rgba(79, 70, 229, 0.12)',
            borderWidth: 1.5,
            pointRadius: 2,
            pointHoverRadius: 4,
            pointBackgroundColor: surface,
            pointBorderColor: primary,
            pointBorderWidth: 1,
            fill: true,
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              title: (items) => `${formatNumber(Number(items[0]?.parsed.x || 0))} files/month`,
              label: (item) => formatReviewCurrency(Number(item.parsed.y || 0)),
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: 0,
            max: maxFiles,
            grid: {
              color: border,
              lineWidth: 0.5,
            },
            border: {
              color: border,
            },
            ticks: {
              color: muted,
              font: {
                size: 11,
                weight: 700,
              },
              maxTicksLimit: 5,
              callback: (value) => {
                const files = Number(value);
                if (files === 0) return '0';
                if (files === maxFiles) return '1M';
                return `${files / 1000}k`;
              },
            },
            title: {
              display: true,
              text: 'Files/month',
              color: muted,
              font: {
                size: 11,
                weight: 700,
              },
            },
          },
          y: {
            beginAtZero: true,
            grid: {
              color: border,
              lineWidth: 0.5,
            },
            border: {
              color: border,
            },
            ticks: {
              color: muted,
              font: {
                size: 11,
                weight: 700,
              },
              maxTicksLimit: 4,
              callback: (value) => formatReviewCurrency(Number(value)),
            },
          },
        },
      },
    });

    return () => chart.destroy();
  }, [averageCostPerDocument, formatReviewCurrency]);

  return (
    <section className="review-chart-card" aria-label="Monthly files and cost projection">
      <div className="review-chart-heading">
        <div>
          <h3>Monthly Volume Projection</h3>
          <p>Estimated cost from current average cost per file, scaled up to 1,000,000 files/month.</p>
        </div>
        <strong>{formatReviewCurrency(projectedCost)}</strong>
      </div>
      <div className="review-chart-wrap">
        <canvas ref={canvasRef} aria-label="Cost projection by monthly file volume" role="img" />
      </div>
    </section>
  );
}

function BusinessReviewScreen({
  displayCurrency,
  onCurrencyChange,
  onNotify,
}: {
  displayCurrency: DisplayCurrency;
  onCurrencyChange: (currency: DisplayCurrency) => void;
  onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [summary, setSummary] = useState<BusinessReviewSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  async function loadSummary() {
    setLoadingSummary(true);
    try {
      setSummary(await api.getBusinessReviewSummary());
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to load business review', 'error');
    } finally {
      setLoadingSummary(false);
    }
  }

  useEffect(() => {
    loadSummary();
  }, []);

  async function resetBusinessReview() {
    setShowResetConfirm(false);
    setLoadingSummary(true);
    try {
      await api.resetBusinessReview();
      setSummary(await api.getBusinessReviewSummary());
      onNotify('Business review data reset', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to reset business review', 'error');
    } finally {
      setLoadingSummary(false);
    }
  }

  if (loadingSummary && !summary) {
    return (
      <section className="panel empty">
        <Loader2 size={24} className="spin" />
        <p>Loading business review.</p>
      </section>
    );
  }

  if (!summary) return <EmptyState text="Business review data is unavailable." />;

  const averageCostPerDocument = summary.filesProcessed
    ? summary.estimatedCostUsd / summary.filesProcessed
    : 0;
  const formatReviewCurrency = (value: number) => formatCurrency(value, displayCurrency);

  return (
    <div className="business-review">
      <section className="panel business-review-overview">
        <div className="panel-heading">
          <div className="business-review-heading">
            <span><BarChart3 size={20} /></span>
            <div>
              <small>Executive overview</small>
              <h2>Processing Summary</h2>
              <p>Persisted processing volume, token usage, and estimated AI processing cost.</p>
            </div>
          </div>
          <div className="toolbar-actions">
            <label className="currency-selector">
              Currency
              <select value={displayCurrency} onChange={(event) => onCurrencyChange(event.target.value as DisplayCurrency)}>
                {displayCurrencyOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button className="icon-button danger" title="Reset business review data" onClick={() => setShowResetConfirm(true)}>
              <Trash2 size={16} />
            </button>
            <button className="icon-button" title="Refresh business review" onClick={loadSummary}>
              {loadingSummary ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            </button>
          </div>
        </div>
        <div className="review-metric-grid">
          <ReviewMetric label="Files processed" value={formatNumber(summary.filesProcessed)} />
          <ReviewMetric label="Estimated cost" value={formatReviewCurrency(summary.estimatedCostUsd)} helper="Extraction + classification + embeddings" />
          <ReviewMetric label="Avg cost / document" value={formatReviewCurrency(averageCostPerDocument)} helper={`${formatNumber(summary.filesProcessed)} processed files`} />
          <ReviewMetric label="Total tokens" value={formatNumber(summary.tokens.total)} />
          <ReviewMetric label="Input tokens" value={formatNumber(summary.tokens.input)} />
          <ReviewMetric label="Output tokens" value={formatNumber(summary.tokens.output)} />
        </div>
        <MonthlyCostProjectionChart
          averageCostPerDocument={averageCostPerDocument}
          formatReviewCurrency={formatReviewCurrency}
        />
      </section>

      <section className="panel business-review-recent">
        <div className="panel-heading">
          <div className="business-review-heading">
            <span><Files size={20} /></span>
            <div>
              <small>Recent activity</small>
              <h2>Recent Processed Files</h2>
              <p>Last five processed documents persisted by the business review.</p>
            </div>
          </div>
        </div>
        <div className="business-review-table">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Classification Model</th>
                <th>Extraction Model</th>
                <th>Tokens</th>
                <th>Extraction Cost</th>
                <th>Classification Cost</th>
                <th>Embedding Cost</th>
                <th>Cost</th>
                <th>Processed</th>
              </tr>
            </thead>
            <tbody>
              {summary.recentDocuments.map((document) => (
                <tr key={`${document.id}-${document.processedAt}`}>
                  <td>{document.name}</td>
                  <td>{displayModel(document.classificationModel)}</td>
                  <td>{displayModel(document.extractionModel)}</td>
                  <td>{formatNumber(document.tokens)}</td>
                  <td>{formatReviewCurrency(document.extractionCostUsd || 0)}</td>
                  <td>{formatReviewCurrency(document.classificationCostUsd || 0)}</td>
                  <td>{formatReviewCurrency(document.embeddingCostUsd || 0)}</td>
                  <td>{formatReviewCurrency(document.estimatedCostUsd)}</td>
                  <td>{new Date(document.processedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!summary.recentDocuments.length && <div className="empty-table">No processed files yet.</div>}
        </div>
      </section>

      {showResetConfirm && (
        <ConfirmDialog
          title="Reset Business Review"
          body={<>Clear all persisted business review totals and recent processed file history? <span className="danger-copy">This cannot be undone.</span></>}
          confirmLabel="Reset"
          confirmIcon={<RotateCcw size={16} />}
          onCancel={() => setShowResetConfirm(false)}
          onConfirm={resetBusinessReview}
        />
      )}
    </div>
  );
}

function ClassificationModeControls({
  config,
  onConfigChange,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
}) {
  return (
    <>
      <label>
        Classification mode
        <select
          value={config.classificationMode}
          onChange={(event) => onConfigChange({
            ...config,
            classificationMode: event.target.value as AppConfig['classificationMode'],
          })}
        >
          <option value="vector">Vector classification</option>
          <option value="llm">LLM classification (all types)</option>
          <option value="rag">RAG classification</option>
        </select>
      </label>
      {config.classificationMode === 'rag' && (
        <label>
          RAG top results
          <input
            type="number"
            min={1}
            max={50}
            value={config.classificationRagTopK}
            onChange={(event) => onConfigChange({
              ...config,
              classificationRagTopK: Math.min(50, Math.max(1, Number(event.target.value) || 1)),
            })}
          />
        </label>
      )}
    </>
  );
}

function ConfigurationScreen({
  config,
  onConfigChange,
  onSave,
  onRefresh,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onSave: (config: AppConfig) => Promise<AppConfig>;
  onRefresh: () => Promise<void>;
}) {
  const [aiServiceTab, setAiServiceTab] = useState<AiProvider>('openai');
  const [configurationTab, setConfigurationTab] = useState<'summary' | 'ai' | 'scaling' | 'caching' | 'encryption' | 'processing' | 'downstream'>('summary');
  const configurationTabs = [
    { id: 'summary', label: 'Summary', icon: Gauge },
    { id: 'ai', label: 'AI Services', icon: Sparkles },
    { id: 'scaling', label: 'Scaling', icon: TrendingUp },
    { id: 'caching', label: 'Caching', icon: Database },
    { id: 'encryption', label: 'Encryption', icon: ShieldCheck },
    { id: 'processing', label: 'Processing', icon: ScanText },
    { id: 'downstream', label: 'Downstream', icon: Network },
  ] as const;
  async function refreshConfig() {
    await onRefresh();
  }

  async function saveConfig() {
    await onSave(config);
  }

  return (
    <div className="panel configuration-panel">
      <div className="configuration-hero">
        <div className="configuration-hero-icon"><Gauge size={24} /></div>
        <div>
          <span>System settings</span>
          <h2>Configure your processing pipeline</h2>
          <p>Manage document preparation, workload capacity, and downstream delivery from one place.</p>
        </div>
        <div className="configuration-hero-note">
          <Save size={16} />
          <span>Changes take effect after saving</span>
        </div>
      </div>
      <div className="configuration-tabs" role="tablist" aria-label="Configuration sections">
        {configurationTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={configurationTab === id}
            className={configurationTab === id ? 'active' : ''}
            onClick={() => setConfigurationTab(id)}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="configuration-form">
        <div className={`configuration-section summary expanded${configurationTab === 'summary' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><Gauge size={20} /></span>
              <span>
                <strong>Configuration Summary</strong>
                <small>Read-only overview of the active application settings</small>
              </span>
            </span>
          </div>
          <div className="configuration-section-body configuration-summary-grid">
            <div className="configuration-summary-group">
              <strong><Sparkles size={15} /> AI Services</strong>
              <dl>
                <div><dt>OpenAI key</dt><dd className={config.openAiApiKeyConfigured ? 'ready' : ''}>{config.openAiApiKeyConfigured ? 'Configured' : 'Not configured'}</dd></div>
                <div><dt>Custom key</dt><dd className={config.customApiKeyConfigured ? 'ready' : ''}>{config.customApiKeyConfigured ? 'Configured' : 'Not configured'}</dd></div>
                <div><dt>Custom endpoint</dt><dd title={config.llmEndpoint || 'Not configured'}>{config.llmEndpoint || 'Not configured'}</dd></div>
                <div><dt>Ollama endpoint</dt><dd title={config.ollamaBaseUrl}>{config.ollamaBaseUrl}</dd></div>
                <div><dt>Classification</dt><dd>{config.classificationMode.toUpperCase()} · {config.classificationModel}</dd></div>
                <div><dt>Embeddings</dt><dd>{config.embeddingProvider} · {config.embeddingProvider === 'ollama' ? config.ollamaEmbeddingModel : config.embeddingModel}</dd></div>
              </dl>
            </div>
            <div className="configuration-summary-group">
              <strong><TrendingUp size={15} /> Scaling</strong>
              <dl>
                <div><dt>Preprocessing</dt><dd>{config.preprocessingConcurrency}</dd></div>
                <div><dt>Vector classification</dt><dd>{config.vectorClassificationConcurrency}</dd></div>
                <div><dt>LLM classification</dt><dd>{config.llmClassificationConcurrency}</dd></div>
                <div><dt>Extraction</dt><dd>{config.extractionConcurrency}</dd></div>
              </dl>
            </div>
            <div className="configuration-summary-group">
              <strong><Database size={15} /> Caching</strong>
              <dl>
                <div><dt>In-memory cache</dt><dd className={config.cachingEnabled ? 'ready' : ''}>{config.cachingEnabled ? 'On' : 'Off'}</dd></div>
                <div><dt>TTL</dt><dd>{config.cachingEnabled ? `${config.configurationCacheTtlSeconds} seconds` : 'Not applicable'}</dd></div>
              </dl>
            </div>
            <div className="configuration-summary-group">
              <strong><ShieldCheck size={15} /> Encryption</strong>
              <dl>
                <div><dt>Processing storage</dt><dd className={config.storageEncryptionEnabled ? 'ready' : ''}>{config.storageEncryptionEnabled ? 'On' : 'Off'}</dd></div>
                <div><dt>Storage key</dt><dd className={config.storageEncryptionKeyConfigured ? 'ready' : ''}>{config.storageEncryptionKeyConfigured ? 'Configured' : 'Not configured'}</dd></div>
                <div><dt>Database extracted data</dt><dd className={config.databaseEncryptionEnabled ? 'ready' : ''}>{config.databaseEncryptionEnabled ? 'On' : 'Off'}</dd></div>
                <div><dt>Database key</dt><dd className={config.databaseEncryptionKeyConfigured ? 'ready' : ''}>{config.databaseEncryptionKeyConfigured ? 'Configured' : 'Not configured'}</dd></div>
              </dl>
            </div>
            <div className="configuration-summary-group">
              <strong><ScanText size={15} /> Processing</strong>
              <dl>
                <div><dt>Prepared text</dt><dd className={config.useOcrForDocumentProcessing ? 'ready' : ''}>{config.useOcrForDocumentProcessing ? 'On' : 'Off'}</dd></div>
                <div><dt>Text engine</dt><dd>{config.useOcrForDocumentProcessing ? (config.documentTextMode === 'markdown' ? 'Docling markdown' : 'Built in') : 'Direct PDF'}</dd></div>
                {config.documentTextMode === 'markdown' && <div><dt>Docling endpoint</dt><dd title={config.markdownServiceUrl}>{config.markdownServiceUrl || 'Not configured'}</dd></div>}
              </dl>
            </div>
            <div className="configuration-summary-group">
              <strong><Network size={15} /> Downstream</strong>
              <dl>
                <div><dt>Endpoint</dt><dd title={config.downstreamUrl || 'Not configured'}>{config.downstreamUrl || 'Not configured'}</dd></div>
                <div><dt>Delete after delivery</dt><dd>{config.deleteAfterDownstream ? 'On' : 'Off'}</dd></div>
                <div><dt>Key-value payload</dt><dd>{config.sendKeyValuePairs ? 'On' : 'Off'}</dd></div>
              </dl>
            </div>
          </div>
        </div>
        <div className={`configuration-section ai expanded${configurationTab === 'ai' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><Sparkles size={20} /></span>
              <span>
                <strong>AI Services</strong>
                <small>Configure the LLM provider, endpoint, model, and encrypted credentials</small>
              </span>
            </span>
            <ChevronUp size={18} />
          </div>
          <div className="configuration-section-body configuration-card-grid classification-style-settings">
            <div className="ai-service-tabs" role="tablist" aria-label="AI services">
              {([
                ['openai', 'OpenAI'],
                ['ollama', 'Ollama'],
                ['custom', 'Custom'],
              ] as const).map(([provider, label]) => (
                <button
                  key={provider}
                  type="button"
                  role="tab"
                  aria-selected={aiServiceTab === provider}
                  className={aiServiceTab === provider ? 'active' : ''}
                  onClick={() => setAiServiceTab(provider)}
                >
                  {label}
                </button>
              ))}
            </div>
            {aiServiceTab === 'openai' && (
              <label>
                <span className="configuration-field-label">
                  OpenAI API key
                  {config.openAiApiKeyConfigured && (
                    <CheckCircle2
                      className="configuration-configured-icon"
                      size={17}
                      aria-label="API key configured"
                    />
                  )}
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={config.openAiApiKeyConfigured ? 'Key configured — enter a new key to replace it' : 'Enter OpenAI API key'}
                  value={config.openAiApiKey}
                  onChange={(event) => onConfigChange({ ...config, openAiApiKey: event.target.value })}
                />
              </label>
            )}
            {aiServiceTab === 'custom' && (
              <>
              <label>
                LLM endpoint
                <input
                  type="url"
                  placeholder="https://llm.example.com/v1"
                  value={config.llmEndpoint}
                  onChange={(event) => onConfigChange({ ...config, llmEndpoint: event.target.value })}
                />
              </label>
              <label>
                <span className="configuration-field-label">
                  Custom API key
                  {config.customApiKeyConfigured && (
                    <CheckCircle2
                      className="configuration-configured-icon"
                      size={17}
                      aria-label="API key configured"
                    />
                  )}
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={config.customApiKeyConfigured ? 'Key configured — enter a new key to replace it' : 'Enter custom API key'}
                  value={config.customApiKey}
                  onChange={(event) => onConfigChange({ ...config, customApiKey: event.target.value })}
                />
              </label>
              </>
            )}
            {aiServiceTab === 'ollama' && (
              <label>
                Ollama endpoint
                <input
                  type="url"
                  value={config.ollamaBaseUrl}
                  onChange={(event) => onConfigChange({ ...config, ollamaBaseUrl: event.target.value })}
                />
              </label>
            )}
            <p className="help-text">
              API keys are encrypted before storage and are never returned to the browser.
            </p>
          </div>
        </div>
        <div className={`configuration-section scaling expanded${configurationTab === 'scaling' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><TrendingUp size={20} /></span>
              <span>
                <strong>Scaling & Concurrency</strong>
                <small>Control parallel processing capacity for every pipeline stage</small>
              </span>
            </span>
            <ChevronUp size={18} />
          </div>
          <div className="configuration-section-body scaling-controls">
              <label className="scaling-control preprocessing">
                <span className="scaling-control-heading">
                  Preprocessing concurrency
                  <output>{config.preprocessingConcurrency}</output>
                </span>
                <span className="scaling-slider">
                  <input
                    type="range"
                    min={1}
                    max={16}
                    step={1}
                    value={config.preprocessingConcurrency}
                    onChange={(event) => onConfigChange({
                      ...config,
                      preprocessingConcurrency: Number(event.target.value),
                    })}
                  />
                  <span><small>1</small><small>16</small></span>
                </span>
                <small>Maximum OCR or Docling preparations running at the same time.</small>
              </label>
              <label className="scaling-control vector">
                <span className="scaling-control-heading">
                  Vector classification concurrency
                  <output>{config.vectorClassificationConcurrency}</output>
                </span>
                <span className="scaling-slider">
                  <input
                    type="range"
                    min={1}
                    max={16}
                    step={1}
                    value={config.vectorClassificationConcurrency}
                    onChange={(event) => onConfigChange({
                      ...config,
                      vectorClassificationConcurrency: Number(event.target.value),
                    })}
                  />
                  <span><small>1</small><small>16</small></span>
                </span>
                <small>Maximum vector-only classifications running at the same time.</small>
              </label>
              <label className="scaling-control llm">
                <span className="scaling-control-heading">
                  LLM classification concurrency
                  <output>{config.llmClassificationConcurrency}</output>
                </span>
                <span className="scaling-slider">
                  <input
                    type="range"
                    min={1}
                    max={16}
                    step={1}
                    value={config.llmClassificationConcurrency}
                    onChange={(event) => onConfigChange({
                      ...config,
                      llmClassificationConcurrency: Number(event.target.value),
                    })}
                  />
                  <span><small>1</small><small>16</small></span>
                </span>
                <small>Maximum LLM or RAG classifications running at the same time.</small>
              </label>
              <label className="scaling-control extraction">
                <span className="scaling-control-heading">
                  Extraction concurrency
                  <output>{config.extractionConcurrency}</output>
                </span>
                <span className="scaling-slider">
                  <input
                    type="range"
                    min={1}
                    max={16}
                    step={1}
                    value={config.extractionConcurrency}
                    onChange={(event) => onConfigChange({
                      ...config,
                      extractionConcurrency: Number(event.target.value),
                    })}
                  />
                  <span><small>1</small><small>16</small></span>
                </span>
                <small>Maximum field extractions running at the same time.</small>
              </label>
              <p className="help-text">
                Limits apply to new queue invocations after saving. Higher AI concurrency may increase model rate-limit errors.
              </p>
          </div>
        </div>

        <div className={`configuration-section caching expanded${configurationTab === 'caching' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><Database size={20} /></span>
              <span>
                <strong>Caching</strong>
                <small>Control per-process configuration caching and MongoDB refresh frequency</small>
              </span>
            </span>
            <ChevronUp size={18} />
          </div>
          <div className="configuration-section-body caching-settings">
            <div className={`caching-card${config.cachingEnabled ? ' enabled' : ''}`}>
              <label className="caching-toggle-row">
                <input
                  type="checkbox"
                  checked={config.cachingEnabled}
                  onChange={(event) => onConfigChange({ ...config, cachingEnabled: event.target.checked })}
                />
                <span>
                  <strong>In-memory configuration caching</strong>
                  <small>
                    {config.cachingEnabled
                      ? 'Configuration is cached independently in every API and processor instance.'
                      : 'Every configuration lookup reads directly from MongoDB.'}
                  </small>
                </span>
                <b>{config.cachingEnabled ? 'On' : 'Off'}</b>
              </label>
              <label className="caching-ttl-row">
                <span>
                  <strong>Cache TTL</strong>
                  <small>Each instance reloads configuration from MongoDB after this interval.</small>
                </span>
                <span className="caching-ttl-input">
                  <input
                    type="number"
                    min={1}
                    max={86400}
                    step={1}
                    disabled={!config.cachingEnabled}
                    value={config.configurationCacheTtlSeconds}
                    onChange={(event) => onConfigChange({
                      ...config,
                      configurationCacheTtlSeconds: Math.min(86400, Math.max(1, Number(event.target.value) || 1)),
                    })}
                  />
                  <span>seconds</span>
                </span>
              </label>
            </div>
          </div>
        </div>

        <div className={`configuration-section processing expanded${configurationTab === 'encryption' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><ShieldCheck size={20} /></span>
              <span>
                <strong>Data Encryption</strong>
                <small>Application-level protection before data reaches storage or the database</small>
              </span>
            </span>
            <ChevronUp size={18} />
          </div>
          <div className="configuration-section-body configuration-card-grid processing-settings classification-style-settings">
            <div className="document-processing-option-card">
              <label className="checkbox-row">
                <input type="checkbox" checked={config.storageEncryptionEnabled}
                  onChange={(event) => onConfigChange({ ...config, storageEncryptionEnabled: event.target.checked })} />
                <span><strong>Processing Storage Encryption</strong><small>Encrypt original, converted, OCR, and markdown processing artifacts.</small></span>
              </label>
              <p className="help-text">{config.storageEncryptionKeyConfigured ? 'Encryption key configured.' : config.storageEncryptionEnabled ? 'A new encryption key will be created when saved.' : 'Encryption key not configured.'}</p>
            </div>
            <div className="document-processing-option-card">
              <label className="checkbox-row">
                <input type="checkbox" checked={config.databaseEncryptionEnabled}
                  onChange={(event) => onConfigChange({ ...config, databaseEncryptionEnabled: event.target.checked })} />
                <span><strong>Database Extracted-Data Encryption</strong><small>Encrypt only extracted field values before saving them in the database.</small></span>
              </label>
              <p className="help-text">{config.databaseEncryptionKeyConfigured ? 'Encryption key configured.' : config.databaseEncryptionEnabled ? 'A new encryption key will be created when saved.' : 'Encryption key not configured.'}</p>
            </div>
            <p className="help-text">These settings apply only to newly ingested documents. Disabling encryption does not decrypt existing data, which remains readable using the retained keys.</p>
          </div>
        </div>

        <div className={`configuration-section processing expanded${configurationTab === 'processing' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><ScanText size={20} /></span>
              <span>
                <strong>Document Processing</strong>
                <small>Choose how document content is prepared for AI processing</small>
              </span>
            </span>
            <ChevronUp size={18} />
          </div>
          <div className="configuration-section-body configuration-card-grid processing-settings classification-style-settings">
              <div className="document-processing-option-card">
                <strong>Text preparation</strong>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.useOcrForDocumentProcessing}
                    onChange={(event) => onConfigChange({ ...config, useOcrForDocumentProcessing: event.target.checked })}
                  />
                  <span>
                    Use extracted text for document processing
                    <small>Extract text before classification, schema generation, and extraction.</small>
                  </span>
                </label>
                {config.useOcrForDocumentProcessing && (
                  <label className="document-processing-field">
                    Text extraction engine
                    <select
                      value={config.documentTextMode}
                      onChange={(event) => onConfigChange({ ...config, documentTextMode: event.target.value as AppConfig['documentTextMode'] })}
                    >
                      <option value="ocr">Built in</option>
                      <option value="markdown">Markdown (Docling service)</option>
                    </select>
                  </label>
                )}
                {config.useOcrForDocumentProcessing && config.documentTextMode === 'markdown' && (
                  <label className="document-processing-field">
                    Docling markdown service URL
                    <input
                      type="url"
                      placeholder="https://your-function-app.azurewebsites.net/api/extract-markdown"
                      value={config.markdownServiceUrl}
                      onChange={(event) => onConfigChange({ ...config, markdownServiceUrl: event.target.value })}
                    />
                  </label>
                )}
                {!config.useOcrForDocumentProcessing && (
                  <p className="warning-text">
                    Processing PDFs directly can cost more because the full PDF is sent to the model instead of extracted OCR or markdown text.
                  </p>
                )}
              </div>
          </div>
        </div>

        <div className={`configuration-section downstream expanded${configurationTab === 'downstream' ? ' active-tab' : ''}`}>
          <div className="configuration-section-toggle">
            <span className="configuration-section-title">
              <span className="configuration-section-icon"><Network size={20} /></span>
              <span>
                <strong>Downstream Delivery</strong>
                <small>Configure where validated document data is sent</small>
              </span>
            </span>
            <ChevronUp size={18} />
          </div>
          <div className="configuration-section-body configuration-card-grid downstream-settings classification-style-settings">
              <label>
                Downstream API URL
                <input
                  type="url"
                  placeholder="https://example.com/api/documents"
                  value={config.downstreamUrl}
                  onChange={(event) => onConfigChange({ ...config, downstreamUrl: event.target.value })}
                />
              </label>
              <div className="downstream-option-card">
                <strong>Delivery options</strong>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.deleteAfterDownstream}
                    onChange={(event) => onConfigChange({ ...config, deleteAfterDownstream: event.target.checked })}
                  />
                  <span>Delete document after sending to downstream</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={config.sendKeyValuePairs}
                    onChange={(event) => onConfigChange({ ...config, sendKeyValuePairs: event.target.checked })}
                  />
                  <span>Send key value pairs</span>
                </label>
              </div>
              <p className="help-text">
                When saved, validation submits will forward clean JSON data to the downstream system using this URL.
              </p>
          </div>
        </div>
        <div className="configuration-actions">
          <button className="secondary-button compact" type="button" onClick={refreshConfig}>
            <RefreshCw size={16} />
            Refresh
          </button>
          <button className="primary-button" type="button" onClick={saveConfig}>
            <Save size={16} />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function classifierStatus(type: DocumentType) {
  if (!type.includeInClassification) return 'excluded';
  if (!type.finalized) return 'draft';
  if (!type.sampleFiles.length) return 'needs sample';
  return type.classifierTrainingStatus || 'untrained';
}

function ClassificationScreen({
  documentTypes,
  config,
  onConfigChange,
  onSaveConfig,
  onRun,
  onRefresh,
}: {
  documentTypes: DocumentType[];
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  onSaveConfig: (config: AppConfig) => Promise<AppConfig>;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const includedTypes = documentTypes.filter((type) => type.includeInClassification);
  const trainableTypes = includedTypes.filter((type) => type.finalized && type.sampleFiles.length > 0);
  const trainingCount = includedTypes.filter((type) => type.classifierTrainingStatus === 'training').length;
  const failedCount = includedTypes.filter((type) => type.classifierTrainingStatus === 'failed').length;
  const trainedCount = includedTypes.filter((type) => type.classifierTrainingStatus === 'trained').length;
  const includedFileCount = includedTypes.reduce((total, type) => total + type.sampleFiles.length, 0);
  const overallStatus = trainingCount
    ? 'training'
    : failedCount
      ? 'failed'
      : trainableTypes.length && trainedCount === trainableTypes.length
        ? 'trained'
        : 'untrained';
  const lastTrainedType = includedTypes
    .filter((type) => type.classifierTrainedAt)
    .sort((left, right) =>
      new Date(right.classifierTrainedAt!).getTime() - new Date(left.classifierTrainedAt!).getTime())[0];

  async function trainIncludedTypes() {
    await api.trainClassifier();
  }

  return (
    <div className="classification-layout">
      <section className="panel classification-training-panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">Classifier workspace</span>
            <h2>Classifier Training</h2>
            <p>Train classification for all document types marked for inclusion.</p>
          </div>
          <div className="classification-training-side">
            <div className="classifier-training-overview">
              <div>
                <span>Status</span>
                <strong className={`classifier-pill ${overallStatus}`}>{overallStatus}</strong>
              </div>
              <div>
                <span>Last trained</span>
                <strong>
                  {lastTrainedType?.classifierTrainedAt
                    ? new Date(lastTrainedType.classifierTrainedAt).toLocaleString()
                    : 'Never'}
                </strong>
              </div>
              <div>
                <span>Last trained by</span>
                <strong>{lastTrainedType?.classifierTrainedBy || '—'}</strong>
              </div>
            </div>
            <div className="panel-heading-actions">
              <button className="icon-button" title="Refresh classifier status" onClick={onRefresh}>
                <RefreshCw size={16} />
              </button>
              <button
                className="secondary-button"
                disabled={overallStatus === 'training'}
                onClick={() =>
                  onRun(async () => {
                    await api.resetClassifierTraining();
                    await onRefresh();
                  }, 'Classifier training status reset')
                }
              >
                <RotateCcw size={16} />
                Reset Status
              </button>
              <button
                className="primary-button"
                disabled={!trainableTypes.length || overallStatus === 'training'}
                onClick={() =>
                  onRun(async () => {
                    await trainIncludedTypes();
                    await onRefresh();
                  }, 'Classifier training queued')
                }
              >
                <BrainCircuit size={16} />
                Train
              </button>
            </div>
          </div>
        </div>

        <div className="classification-settings">
          <div className="classification-settings-heading">
            <div>
              <span>Classification configuration</span>
              <strong>{aiModelLabel(config)}</strong>
              <small>
                {config.classificationMode === 'vector'
                  ? `Top vector result using ${embeddingModelLabel(config)}.`
                  : config.classificationMode === 'rag'
                    ? `LLM chooses from the top ${config.classificationRagTopK} vector results.`
                    : 'LLM chooses from all configured document types.'}
              </small>
            </div>
            <button
              className="primary-button compact"
              type="button"
              onClick={() => onRun(() => onSaveConfig(config).then(() => undefined), 'Classification configuration saved')}
            >
              <Save size={16} />
              Save settings
            </button>
          </div>
          <div className="classification-settings-grid">
            <section className="classification-setting-card strategy">
              <div className="classification-setting-card-heading">
                <BrainCircuit size={18} />
                <div><strong>Classification strategy</strong><small>Choose how document types are selected.</small></div>
              </div>
              <div className="classification-setting-fields">
                <ClassificationModeControls config={config} onConfigChange={onConfigChange} />
              </div>
            </section>

            <section className="classification-setting-card model">
              <div className="classification-setting-card-heading">
                <Sparkles size={18} />
                <div><strong>Classification model</strong><small>Configure the AI provider and model.</small></div>
              </div>
              <div className="classification-setting-fields">
                <label>
                  AI provider
                  <select
                    value={config.aiProvider}
                    onChange={(event) => onConfigChange({ ...config, aiProvider: event.target.value as AiProvider })}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="custom">Custom (OpenAI compatible)</option>
                    <option value="ollama">Self Hosted (Ollama)</option>
                  </select>
                </label>
                {config.aiProvider !== 'ollama' ? (
                  <OpenAIModelControls
                    model={config.classificationModel || lowCostOpenAIModel}
                    reasoningEffort={config.classificationReasoningEffort || 'low'}
                    onModelChange={(classificationModel) => onConfigChange({ ...config, classificationModel })}
                    onReasoningEffortChange={(classificationReasoningEffort) => onConfigChange({ ...config, classificationReasoningEffort })}
                  />
                ) : (
                  <>
                    <label>
                      Ollama base URL
                      <input
                        type="url"
                        value={config.ollamaBaseUrl}
                        placeholder={defaultOllamaBaseUrl}
                        onChange={(event) => onConfigChange({ ...config, ollamaBaseUrl: event.target.value })}
                      />
                    </label>
                    <label>
                      Ollama model
                      <input
                        value={config.ollamaModel}
                        placeholder={defaultOllamaModel}
                        onChange={(event) => onConfigChange({ ...config, ollamaModel: event.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            </section>

            <section className="classification-setting-card embedding">
              <div className="classification-setting-card-heading">
                <Network size={18} />
                <div><strong>Embedding settings</strong><small>Configure vectors used for search and RAG.</small></div>
              </div>
              <div className="classification-setting-fields">
                <label>
                  Embedding provider
                  <select
                    value={config.embeddingProvider}
                    onChange={(event) => onConfigChange({ ...config, embeddingProvider: event.target.value as EmbeddingProvider })}
                  >
                    <option value="openai">OpenAI</option>
                    <option value="ollama">Self Hosted (Ollama)</option>
                  </select>
                </label>
                {config.embeddingProvider === 'ollama' ? (
                  <label>
                    Ollama embedding model
                    <input
                      value={config.ollamaEmbeddingModel}
                      placeholder={defaultOllamaEmbeddingModel}
                      onChange={(event) => onConfigChange({ ...config, ollamaEmbeddingModel: event.target.value })}
                    />
                  </label>
                ) : (
                  <label>
                    OpenAI embedding model
                    <select
                      value={config.embeddingModel}
                      onChange={(event) => onConfigChange({ ...config, embeddingModel: event.target.value })}
                    >
                      {config.embeddingModel && !openAIEmbeddingModelOptions.some((option) => option.value === config.embeddingModel) && (
                        <option value={config.embeddingModel}>{config.embeddingModel}</option>
                      )}
                      {openAIEmbeddingModelOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </section>
          </div>
        </div>
      </section>

      <section className="panel classification-types-card">
        <div className="classification-types-heading">
          <div className="classification-types-title">
            <span><Files size={18} /></span>
            <div>
              <strong>Document Types</strong>
              <small>Types currently included in classifier training.</small>
            </div>
          </div>
          <div className="classification-type-counts" aria-label="Document type summary">
            <span className="classification-types-count included">
              <strong>{includedTypes.length}</strong> Included
            </span>
            <span className="classification-types-count trainable">
              <strong>{trainableTypes.length}</strong> Trainable
            </span>
            <span className="classification-types-count trained">
              <strong>{trainedCount}</strong> Trained
            </span>
            <span className="classification-types-count samples">
              <strong>{includedFileCount}</strong> Sample files
            </span>
          </div>
        </div>
        <div className="classification-table">
          {includedTypes.map((type) => {
            const status = classifierStatus(type);
            return (
              <div className="classification-row" key={type._id}>
                <div className="classification-type-identity">
                  <span className="classification-type-icon"><FileText size={16} /></span>
                  <div>
                    <strong>{type.name}</strong>
                    <small>{type.category}</small>
                  </div>
                </div>
                <span className="file-count">{type.sampleFiles.length} file{type.sampleFiles.length === 1 ? '' : 's'}</span>
                <span className={`classifier-pill ${status.replace(/\s+/g, '-')}`}>{status}</span>
              </div>
            );
          })}
          {!includedTypes.length && <EmptyState text="No document types are included in classification." />}
        </div>
      </section>
    </div>
  );
}

function DocumentTypeManagement({
  documentTypes,
  activeType,
  config,
  onConfigChange,
  setActiveTypeId,
  categories,
  onRun,
  onRefresh,
  onDocumentTypeSaved,
}: {
  documentTypes: DocumentType[];
  activeType?: DocumentType;
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
  setActiveTypeId: (id: string) => void;
  categories: string[];
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onDocumentTypeSaved: (documentType: DocumentType) => void;
}) {
  const [prompt, setPrompt] = useState('Invoice number, invoice date, supplier name, subtotal, tax amount, total amount');
  const [sample, setSample] = useState<File | null>(null);
  const [fields, setFields] = useState<ExtractionField[]>([]);
  const [schemaEditing, setSchemaEditing] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Record<string, boolean>>({});
  const [isFileListExpanded, setIsFileListExpanded] = useState(false);
  const [isSchemaExpanded, setIsSchemaExpanded] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [deleteTypeTarget, setDeleteTypeTarget] = useState<DocumentType | null>(null);

  useEffect(() => {
    setFields(withUiIds(activeType?.fields ?? []));
    setPrompt(activeType?.prompt || prompt);
    setSchemaEditing(false);
    setExpandedTables({});
    setIsFileListExpanded(false);
    setIsSchemaExpanded(true);
  }, [activeType?._id]);

  function addSchemaField() {
    const nextNumber = fields.length + 1;
    setFields([
      ...fields,
      {
        key: `new_field_${nextNumber}`,
        label: `New Field ${nextNumber}`,
        type: 'string',
        description: '',
        selected: true,
        columns: [],
        uiId: `new-field-${Date.now()}-${nextNumber}`,
      },
    ]);
  }

  function removeSchemaField(index: number) {
    setFields(fields.filter((_, fieldIndex) => fieldIndex !== index));
  }

  return (
    <div className="document-type-layout">
      <div className="two-column document-type-workspace">
      <section className="panel document-type-list-panel">
        <div className="panel-heading">
          <div>
            <span className="section-kicker">Type library</span>
            <h2>Document Types</h2>
            <p>Select a type to manage its samples and extraction schema.</p>
          </div>
          <div className="panel-heading-actions">
            <button className="icon-button" title="Refresh document types" onClick={onRefresh}>
              <RefreshCw size={16} />
            </button>
            <button className="icon-button" title="Create document type" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
            </button>
          </div>
        </div>
        <div className="type-list">
          {documentTypes.map((type) => (
            <button
              key={type._id}
              className={activeType?._id === type._id ? 'type-row active' : 'type-row'}
              onClick={() => setActiveTypeId(type._id)}
            >
              <span className="type-row-identity">
                <span className="type-row-icon"><FileText size={17} /></span>
                <span>
                  <strong>{type.name}</strong>
                  <small>{type.category}</small>
                </span>
              </span>
              <em className={`type-state ${!type.finalized ? 'draft' : type.classifierTrainingStatus || 'untrained'}`}>
                {!type.finalized
                  ? 'Draft'
                  : type.classifierTrainingStatus === 'trained'
                    ? 'Trained'
                    : type.classifierTrainingStatus === 'training'
                      ? 'Training'
                      : type.sampleFiles.length
                        ? type.classifierTrainingStatus || 'Untrained'
                        : 'Needs sample'}
              </em>
            </button>
          ))}
        </div>
      </section>

      <section className="panel document-type-editor-panel">
        {activeType ? (
          <>
            <div className="panel-heading document-type-editor-heading">
              <div>
                <span className="section-kicker">Type configuration</span>
                <h2>{activeType.name}</h2>
                <div className="document-type-heading-meta">
                  <span>{activeType.category}</span>
                  <span>{fields.length} field{fields.length === 1 ? '' : 's'}</span>
                  <span>{activeType.sampleFiles.length} sample{activeType.sampleFiles.length === 1 ? '' : 's'}</span>
                </div>
              </div>
              <button
                className="icon-button danger"
                title="Delete document type"
                onClick={() => setDeleteTypeTarget(activeType)}
              >
                <Trash2 size={17} />
              </button>
            </div>

            <div className={activeType.classifierTrainingStatus === 'trained' ? 'training-status ready document-type-training-status' : 'training-status document-type-training-status'}>
              <Gauge size={16} />
              <span>
                Classifier training: {activeType.classifierTrainingStatus || 'untrained'} with {activeType.sampleFiles.length} sample
                {activeType.sampleFiles.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="document-type-config-grid">
            <section className="document-type-config-card model-card">
              <div className="document-type-card-heading">
                <span><BrainCircuit size={18} /></span>
                <div>
                  <strong>Extraction Model</strong>
                  <small>Model and reasoning settings used for this document type.</small>
                </div>
              </div>
              <div className="model-settings-band">
              <label>
                AI service
                <select
                  value={activeType.extractionAiProvider || 'openai'}
                  onChange={(event) =>
                    onRun(async () => {
                      const extractionAiProvider = event.target.value as NonNullable<DocumentType['extractionAiProvider']>;
                      const updated = await api.updateExtractionModel(activeType._id, {
                        extractionAiProvider,
                        extractionModel: activeType.extractionModel || (extractionAiProvider === 'ollama' ? config.ollamaModel : lowCostOpenAIModel),
                        extractionReasoningEffort: activeType.extractionReasoningEffort || 'low',
                        extractionVerification: Boolean(activeType.extractionVerification),
                      });
                      onDocumentTypeSaved(updated);
                      await onRefresh();
                    }, 'Extraction AI service saved')
                  }
                >
                  <option value="openai">OpenAI</option>
                  <option value="custom">Custom</option>
                  <option value="ollama">Ollama</option>
                </select>
              </label>
              {(activeType.extractionAiProvider || 'openai') !== 'ollama' ? (
                <OpenAIModelControls
                  model={activeType.extractionModel || lowCostOpenAIModel}
                  reasoningEffort={activeType.extractionReasoningEffort || 'low'}
                  onModelChange={(extractionModel) =>
                    onRun(async () => {
                      const updated = await api.updateExtractionModel(activeType._id, {
                        extractionModel,
                        extractionAiProvider: activeType.extractionAiProvider || 'openai',
                        extractionReasoningEffort: activeType.extractionReasoningEffort || 'low',
                        extractionVerification: Boolean(activeType.extractionVerification),
                      });
                      onDocumentTypeSaved(updated);
                      await onRefresh();
                    }, 'Extraction model saved')
                  }
                  onReasoningEffortChange={(extractionReasoningEffort) =>
                    onRun(async () => {
                      const updated = await api.updateExtractionModel(activeType._id, {
                        extractionModel: activeType.extractionModel || lowCostOpenAIModel,
                        extractionAiProvider: activeType.extractionAiProvider || 'openai',
                        extractionReasoningEffort,
                        extractionVerification: Boolean(activeType.extractionVerification),
                      });
                      onDocumentTypeSaved(updated);
                      await onRefresh();
                    }, 'Extraction reasoning effort saved')
                  }
                />
              ) : (
                <div className="model-controls">
                  <label>
                    Model
                    <input
                      value={activeType.extractionModel || config.ollamaModel}
                      onChange={(event) => onDocumentTypeSaved({ ...activeType, extractionModel: event.target.value })}
                      onBlur={(event) =>
                        onRun(async () => {
                          const updated = await api.updateExtractionModel(activeType._id, {
                            extractionModel: event.target.value,
                            extractionAiProvider: 'ollama',
                            extractionReasoningEffort: activeType.extractionReasoningEffort || 'low',
                            extractionVerification: Boolean(activeType.extractionVerification),
                          });
                          onDocumentTypeSaved(updated);
                          await onRefresh();
                        }, 'Extraction model saved')
                      }
                    />
                  </label>
                </div>
              )}
              </div>
            </section>

            <section className="document-type-config-card options-card">
              <div className="document-type-card-heading">
                <span><ClipboardCheck size={18} /></span>
                <div>
                  <strong>Processing Options</strong>
                  <small>Control verification and classification behavior.</small>
                </div>
              </div>
              <div className="document-type-option-list">
              <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(activeType.extractionVerification)}
                onChange={(event) => {
                  const extractionVerification = event.currentTarget.checked;
                  const successMessage = extractionVerification
                    ? 'Extraction verification enabled'
                    : 'Extraction verification disabled';
                  return onRun(async () => {
                    const updated = await api.updateExtractionModel(activeType._id, {
                      extractionModel: activeType.extractionModel || lowCostOpenAIModel,
                      extractionAiProvider: activeType.extractionAiProvider || 'openai',
                      extractionReasoningEffort: activeType.extractionReasoningEffort || 'low',
                      extractionVerification,
                    });
                    onDocumentTypeSaved({
                      ...updated,
                      extractionVerification,
                    });
                  }, successMessage);
                }}
              />
              <span>
                Extraction verification
                <small>Have the LLM verify extracted data against the document content and correct mismatches.</small>
              </span>
              </label>

              <label className="checkbox-row">
              <input
                type="checkbox"
                checked={Boolean(activeType.includeInClassification)}
                onChange={(event) =>
                  onRun(async () => {
                    await api.updateClassificationInclusion(activeType._id, event.target.checked);
                    await onRefresh();
                  }, event.target.checked ? 'Included in classification' : 'Removed from classification')
                }
              />
              <span>
                Include in classification
                <small>Use this document type and its samples when running classifier training.</small>
              </span>
              </label>
              </div>
            </section>

            <section className="document-type-config-card files-card">
              <div className="document-type-card-heading">
                <span><Files size={18} /></span>
                <div>
                  <strong>Training Files</strong>
                  <small>Upload and manage representative samples for classification.</small>
                </div>
              </div>
              <div className="sample-row">
              <input type="file" accept="application/pdf" onChange={(event) => setSample(event.target.files?.[0] ?? null)} />
              <button
                className="secondary-button"
                disabled={!sample}
                onClick={() =>
                  sample &&
                  onRun(async () => {
                    await api.uploadSample(activeType._id, sample);
                    setSample(null);
                    await onRefresh();
                  }, 'Sample uploaded')
                }
              >
                <Upload size={16} />
                Sample
              </button>
              </div>

              <div className="sample-file-list">
              <button
                className="collapsible-section-heading"
                type="button"
                onClick={() => setIsFileListExpanded((current) => !current)}
              >
                <span>
                  {isFileListExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  Uploaded Documents
                </span>
                <span>{activeType.sampleFiles.length} file{activeType.sampleFiles.length === 1 ? '' : 's'}</span>
              </button>
              {isFileListExpanded && (
                activeType.sampleFiles.length ? (
                  activeType.sampleFiles.map((fileName) => (
                    <div className="sample-file-row" key={fileName}>
                      <span title={fileName}>{displaySampleName(fileName)}</span>
                      <button
                        className="icon-button danger"
                        title="Delete sample file"
                        onClick={() =>
                          onRun(async () => {
                            await api.deleteSample(activeType._id, fileName);
                            await onRefresh();
                          }, 'Sample deleted')
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="empty-table">No documents uploaded for this type.</div>
                )
              )}
              </div>
            </section>

            <section className="document-type-config-card schema-card">
              <div className="document-type-card-heading">
                <span><ScanText size={18} /></span>
                <div>
                  <strong>Extraction Schema</strong>
                  <small>Define the fields and tables extracted from this document type.</small>
                </div>
              </div>
            {!fields.length && (
              <>
                <label className="full-label">
                  Prompt
                  <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} />
                </label>
              </>
            )}
            {!fields.length && (
              <button
                className="primary-button"
                onClick={() =>
                  onRun(async () => {
                    const updated = await api.generateTemplate(activeType._id, prompt);
                    setFields(withUiIds(updated.fields));
                    setSchemaEditing(false);
                    await onRefresh();
                  }, 'Template generated')
                }
              >
                <FileSearch size={16} />
                Generate Template
              </button>
            )}

            {!!fields.length && (
              <div className="collapsible-section schema-card-content">
                <div className="schema-toolbar">
                  <button
                    className="collapsible-section-title"
                    type="button"
                    onClick={() => setIsSchemaExpanded((current) => !current)}
                  >
                    {isSchemaExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    <span>Extraction Schema</span>
                  </button>
                  {isSchemaExpanded && (
                    !schemaEditing ? (
                      <button className="secondary-button" onClick={() => setSchemaEditing(true)}>
                        <Pencil size={16} />
                        Edit Schema
                      </button>
                    ) : (
                      <div className="schema-actions">
                        <button className="secondary-button" onClick={addSchemaField}>
                          <Plus size={16} />
                          Add Field
                        </button>
                        <button
                          className="primary-button"
                          onClick={() =>
                            onRun(async () => {
                              await api.finalizeTemplate(activeType._id, fields);
                              setSchemaEditing(false);
                              await onRefresh();
                            }, 'Schema saved')
                          }
                        >
                          <Save size={16} />
                          Save Schema
                        </button>
                      </div>
                    )
                  )}
                </div>

                {isSchemaExpanded && (
                  <div className="fields-table">
                    {fields.map((field, index) => (
                <div className="schema-field" key={field.uiId || `${field.key}-${index}`}>
                  <div className={schemaEditing ? 'field-row editable' : 'field-row readonly'}>
                    <input
                      type="checkbox"
                      checked={field.selected}
                      disabled={!schemaEditing}
                      onChange={(event) => {
                        const next = [...fields];
                        next[index] = { ...field, selected: event.target.checked };
                        setFields(next);
                      }}
                    />
                    <input
                      value={field.label}
                      disabled={!schemaEditing}
                      onChange={(event) => {
                        const next = [...fields];
                        next[index] = { ...field, label: event.target.value };
                        setFields(next);
                      }}
                    />
                    <select
                      value={field.type}
                      disabled={!schemaEditing}
                      onChange={(event) => {
                        const type = event.target.value as FieldType;
                        const next = [...fields];
                        next[index] = {
                          ...field,
                          type,
                          columns:
                            type === 'table'
                              ? field.columns?.length
                                ? field.columns
                                : defaultTableColumns()
                              : [],
                        };
                        setFields(next);
                      }}
                    >
                      {fieldTypes.map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                    </select>
                    {schemaEditing && (
                      <button
                        className="icon-button danger"
                        title="Remove field"
                        onClick={() => removeSchemaField(index)}
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                  <div className={schemaEditing ? 'field-description' : 'field-description readonly'}>
                    <textarea
                      value={field.description || ''}
                      disabled={!schemaEditing}
                      rows={2}
                      placeholder="Describe what should be extracted for this field"
                      onChange={(event) => {
                        const next = [...fields];
                        next[index] = { ...field, description: event.target.value };
                        setFields(next);
                      }}
                    />
                  </div>

                  {field.type === 'table' && (
                    <div className={schemaEditing ? 'table-columns' : 'table-columns readonly'}>
                      <div className="table-columns-heading">
                        <button
                          className="table-toggle"
                          onClick={() =>
                            setExpandedTables((current) => ({
                              ...current,
                              [field.uiId || field.key]: !(current[field.uiId || field.key] ?? true),
                            }))
                          }
                        >
                          {(expandedTables[field.uiId || field.key] ?? true) ? <ChevronUp size={14} /> : <ChevronRight size={14} />}
                          <span>Table fields</span>
                        </button>
                        <div className="table-columns-actions">
                          {schemaEditing && (
                            <button
                              className="secondary-button compact"
                              onClick={() => {
                                const next = [...fields];
                                const columns = next[index].columns || [];
                                next[index] = {
                                  ...field,
                                  columns: [
                                    ...columns,
                                    {
                                      key: `column_${columns.length + 1}`,
                                      label: `Column ${columns.length + 1}`,
                                      type: 'string',
                                      description: '',
                                    },
                                  ],
                                };
                                setFields(next);
                                setExpandedTables((current) => ({
                                  ...current,
                                  [field.uiId || field.key]: true,
                                }));
                              }}
                            >
                              <Plus size={14} />
                              Add
                            </button>
                          )}
                        </div>
                      </div>
                      {(expandedTables[field.uiId || field.key] ?? true) &&
                        (field.columns || []).map((column, columnIndex) => (
                          <div className="column-editor" key={`${field.uiId || field.key}-${column.key}-${columnIndex}`}>
                            <div className="column-row">
                              <input
                                value={column.label}
                                disabled={!schemaEditing}
                                onChange={(event) => {
                                  const next = [...fields];
                                  const columns = [...(next[index].columns || [])];
                                  columns[columnIndex] = {
                                    ...column,
                                    label: event.target.value,
                                  };
                                  next[index] = { ...field, columns };
                                  setFields(next);
                                }}
                              />
                              <select
                                value={column.type}
                                disabled={!schemaEditing}
                                onChange={(event) => {
                                  const next = [...fields];
                                  const columns = [...(next[index].columns || [])];
                                  columns[columnIndex] = { ...column, type: event.target.value as FieldType };
                                  next[index] = { ...field, columns };
                                  setFields(next);
                                }}
                              >
                                {fieldTypes.filter((type) => type !== 'table').map((type) => (
                                  <option key={type}>{type}</option>
                                ))}
                              </select>
                              {schemaEditing && (
                                <button
                                  className="icon-button danger"
                                  title="Remove table field"
                                  onClick={() => {
                                    const next = [...fields];
                                    const columns = [...(next[index].columns || [])];
                                    columns.splice(columnIndex, 1);
                                    next[index] = { ...field, columns };
                                    setFields(next);
                                  }}
                                >
                                  <Trash2 size={15} />
                                </button>
                              )}
                            </div>
                            <div className={schemaEditing ? 'column-description' : 'column-description readonly'}>
                              <textarea
                                value={column.description || ''}
                                disabled={!schemaEditing}
                                rows={2}
                                placeholder="Describe what should be extracted for this table column"
                                onChange={(event) => {
                                  const next = [...fields];
                                  const columns = [...(next[index].columns || [])];
                                  columns[columnIndex] = { ...column, description: event.target.value };
                                  next[index] = { ...field, columns };
                                  setFields(next);
                                }}
                              />
                            </div>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            </section>
            </div>
          </>
        ) : (
          <EmptyState text="Select a document type to view details." />
        )}
      </section>
      </div>
      {showCreateModal && (
        <CreateDocumentTypeModal
          documentTypes={documentTypes}
          categories={categories}
          onCancel={() => setShowCreateModal(false)}
          onCreate={(created) => {
            setActiveTypeId(created._id);
            setShowCreateModal(false);
            onRefresh();
          }}
          onRun={onRun}
        />
      )}
      {deleteTypeTarget && (
        <ConfirmDialog
          title="Delete Document Type"
          body={`Delete "${deleteTypeTarget.name}" and its uploaded documents? This cannot be undone.`}
          confirmLabel="Delete"
          confirmIcon={<Trash2 size={16} />}
          onCancel={() => setDeleteTypeTarget(null)}
          onConfirm={() => {
            const target = deleteTypeTarget;
            setDeleteTypeTarget(null);
            onRun(async () => {
              await api.deleteDocumentType(target._id);
              await onRefresh();
            }, 'Document type deleted');
          }}
        />
      )}
    </div>
  );
}

function CreateDocumentTypeModal({
  documentTypes,
  categories,
  onCancel,
  onCreate,
  onRun,
}: {
  documentTypes: DocumentType[];
  categories: string[];
  onCancel: () => void;
  onCreate: (created: DocumentType) => void;
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
}) {
  const [isNewCategory, setIsNewCategory] = useState(false);
  const [newCategoryInput, setNewCategoryInput] = useState('');
  const [category, setCategory] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [errors, setErrors] = useState<{ name?: string; category?: string; prompt?: string }>({});

  const validate = () => {
    const trimmedName = name.trim();
    const trimmedCategory = category.trim();
    const trimmedPrompt = prompt.trim();
    const nextErrors: typeof errors = {};

    if (!trimmedName) {
      nextErrors.name = 'Document type name is required.';
    } else if (documentTypes.some((type) => type.name.toLowerCase() === trimmedName.toLowerCase())) {
      nextErrors.name = 'A document type with this name already exists.';
    }

    if (!trimmedCategory) {
      nextErrors.category = 'Category is required.';
    }

    if (!trimmedPrompt) {
      nextErrors.prompt = 'Extraction prompt is required.';
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal">
        <div className="modal-heading">
          <div>
            <h2>Create Document Type</h2>
            <p>Define a new document type for extraction.</p>
          </div>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <X size={17} />
          </button>
        </div>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            if (!validate()) {
              return;
            }
            onRun(async () => {
              const created = await api.createDocumentType({ category, name: name.trim(), prompt: prompt.trim() });
              onCreate(created);
            }, 'Document type created');
          }}
        >
          <div>
            {!isNewCategory ? (
              <label>
                Category
                <div style={{ display: 'flex', gap: '8px' }}>
                  <select
                    value={category}
                    onChange={(event) => {
                      setCategory(event.target.value);
                      if (errors.category && event.target.value.trim()) {
                        setErrors((current) => ({ ...current, category: undefined }));
                      }
                    }}
                    className={errors.category ? 'input-error' : ''}
                  >
                    <option value="">Select a category</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                  {errors.category ? <div className="field-error">{errors.category}</div> : null}
                  <button
                    type="button"
                    className="secondary-button"
                    title="Add new category"
                    onClick={() => {
                      setIsNewCategory(true);
                      setNewCategoryInput('');
                    }}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </label>
            ) : (
              <label>
                New Category
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    value={newCategoryInput}
                    onChange={(event) => setNewCategoryInput(event.target.value)}
                    placeholder="Enter new category"
                    autoFocus
                    required
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    title="Use this category"
                    onClick={() => {
                      if (newCategoryInput.trim()) {
                        setCategory(newCategoryInput.trim());
                        setIsNewCategory(false);
                        setNewCategoryInput('');
                        if (errors.category) {
                          setErrors((current) => ({ ...current, category: undefined }));
                        }
                      }
                    }}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    <CheckCircle2 size={16} />
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    title="Cancel"
                    onClick={() => {
                      setIsNewCategory(false);
                      setNewCategoryInput('');
                    }}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    <X size={16} />
                  </button>
                </div>
              </label>
            )}
          </div>
          <label>
            Document type
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (errors.name && event.target.value.trim()) {
                  setErrors((current) => ({ ...current, name: undefined }));
                }
              }}
              className={errors.name ? 'input-error' : ''}
            />
            {errors.name ? <div className="field-error">{errors.name}</div> : null}
          </label>
          <label className="span-2">
            Extraction prompt
            <textarea
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                if (errors.prompt && event.target.value.trim()) {
                  setErrors((current) => ({ ...current, prompt: undefined }));
                }
              }}
              rows={4}
              className={errors.prompt ? 'input-error' : ''}
            />
            {errors.prompt ? <div className="field-error">{errors.prompt}</div> : null}
          </label>
          <div className="modal-footer">
            <button className="secondary-button" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button className="primary-button" type="submit">
              <Plus size={16} />
              Create
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function UploadScreen({
  categories,
  documentTypes,
  onRun,
  onRefresh,
  openDocuments,
}: {
  categories: string[];
  documentTypes: DocumentType[];
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  openDocuments: () => void;
}) {
  const [category, setCategory] = useState(categories[0] ?? '');
  const availableTypes = documentTypes.filter((type) => type.category === category);
  const [documentTypeId, setDocumentTypeId] = useState(availableTypes[0]?._id ?? '');
  const [autoClassify, setAutoClassify] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const trainedTypeCount = documentTypes.filter((type) => type.finalized && type.sampleFiles.length > 0).length;
  const totalFileSize = files.reduce((total, file) => total + file.size, 0);
  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  useEffect(() => {
    setCategory((current) => current || categories[0] || '');
  }, [categories]);

  useEffect(() => {
    const first = documentTypes.find((type) => type.category === category);
    setDocumentTypeId(first?._id ?? '');
  }, [category, documentTypes.length]);

  return (
    <section className="panel upload-panel">
      <div className="panel-heading upload-heading">
        <div>
          <span className="upload-kicker"><Sparkles size={14} /> Intelligent intake</span>
          <h2>Upload Documents</h2>
          <p>Drop files here and let Xtract classify, read, and structure them.</p>
        </div>
        <button className="icon-button" title="Refresh upload page" onClick={onRefresh}>
          <RefreshCw size={16} />
        </button>
      </div>
      <form
        className="form-grid"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!files.length) return;
          onRun(async () => {
            await api.uploadDocuments(autoClassify ? { files } : { category, documentTypeId, files });
            await onRefresh();
            openDocuments();
          }, autoClassify ? 'Documents classified and processed' : 'Documents uploaded and processed');
        }}
      >
        <label className="span-2 checkbox-row upload-classification-toggle">
          <input
            type="checkbox"
            checked={autoClassify}
            onChange={(event) => setAutoClassify(event.target.checked)}
          />
          <span className="upload-toggle-icon"><BrainCircuit size={20} /></span>
          <span>
            <strong>Auto-classify documents</strong>
            <small>Match against {trainedTypeCount} trained document type{trainedTypeCount === 1 ? '' : 's'} automatically</small>
          </span>
          <span className="upload-recommended">Recommended</span>
        </label>
        {!autoClassify && (
          <>
            <label>
              Category
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Document type
              <select value={documentTypeId} onChange={(event) => setDocumentTypeId(event.target.value)}>
                {availableTypes.map((type) => (
                  <option key={type._id} value={type._id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label
          className={`file-drop span-2${draggingFiles ? ' dragging' : ''}${files.length ? ' has-files' : ''}`}
          onDragEnter={() => setDraggingFiles(true)}
          onDragOver={(event) => {
            event.preventDefault();
            setDraggingFiles(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingFiles(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDraggingFiles(false);
            setFiles(Array.from(event.dataTransfer.files).filter((file) =>
              file.type === 'application/pdf' || file.type.startsWith('image/'),
            ));
          }}
        >
          <span className="file-drop-icon"><Upload size={30} /></span>
          <strong>
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? '' : 's'} selected`
              : 'Drop your documents here'}
          </strong>
          <span>{files.length ? `${formatFileSize(totalFileSize)} ready to upload` : 'or click to browse your computer'}</span>
          <small>PDF, PNG, JPG, TIFF · Multiple files supported</small>
          <input
            type="file"
            accept="application/pdf,image/*,.tif,.tiff"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </label>
        {files.length > 0 && (
          <div className="upload-file-list span-2">
            {files.map((file, index) => (
              <div className="upload-file-item" key={`${file.name}-${file.size}-${index}`}>
                <span className="upload-file-type">
                  {file.type === 'application/pdf' ? <FileText size={18} /> : <FileImage size={18} />}
                </span>
                <span>
                  <strong>{file.name}</strong>
                  <small>{formatFileSize(file.size)}</small>
                </span>
                <button
                  className="icon-button"
                  type="button"
                  title={`Remove ${file.name}`}
                  onClick={() => setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="upload-submit-row span-2">
          <span>
            <ShieldCheck size={16} />
            Files are processed securely
          </span>
          <button
            className="primary-button upload-submit"
            disabled={(!autoClassify && !documentTypeId) || (autoClassify && trainedTypeCount === 0) || files.length === 0}
          >
            <Upload size={16} />
            {autoClassify ? 'Classify & Process' : `Upload Document${files.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </section>
  );
}

function DocumentList({
  documents,
  documentTypes,
  pagination,
  statusTarget,
  onStatusTargetApplied,
  config,
  canManage = false,
  onOpen,
  onPage,
}: {
  documents: IncomingDocument[];
  documentTypes: DocumentType[];
  pagination: PagedResult<IncomingDocument>;
  statusTarget: { status: DocumentStatusFilter; version: number };
  onStatusTargetApplied: () => void;
  config: AppConfig;
  canManage?: boolean;
  onOpen: (id: string) => void;
  onPage: (page: PagedResult<IncomingDocument>) => void;
}) {
  const [status, setStatus] = useState<DocumentStatusFilter>('');
  const [category, setCategory] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [sort, setSort] = useState('latest');
  const [pageSize, setPageSize] = useState(10);
  const [deleteTarget, setDeleteTarget] = useState<IncomingDocument | null>(null);
  const [reprocessTarget, setReprocessTarget] = useState<IncomingDocument | null>(null);
  const [reclassifyTarget, setReclassifyTarget] = useState<IncomingDocument | null>(null);
  const [justificationTarget, setJustificationTarget] = useState<IncomingDocument | null>(null);
  const [flowTarget, setFlowTarget] = useState<IncomingDocument | null>(null);
  const [reclassifyCategory, setReclassifyCategory] = useState('');
  const [reclassifyDocumentType, setReclassifyDocumentType] = useState('');
  const categories = Array.from(new Set(documentTypes.map((type) => type.category))).sort();

  const reclassifyAvailableTypes = documentTypes.filter((type) => type.category === reclassifyCategory);

  async function loadPage(page: number) {
    const params = new URLSearchParams({
      sort,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (status) params.set('status', status);
    if (category) params.set('category', category);
    if (nameFilter) params.set('name', nameFilter);
    onPage(await api.listDocuments(params));
  }

  async function applyFilters() {
    await loadPage(1);
  }

  useEffect(() => {
    if (statusTarget.version === 0) return;

    const nextStatus = statusTarget.status;
    onStatusTargetApplied();
    setStatus(nextStatus);
    setCategory('');
    setNameFilter('');
    setSort('latest');
    setPageSize(10);

    const params = new URLSearchParams({
      sort: 'latest',
      page: '1',
      pageSize: '10',
    });
    if (nextStatus) params.set('status', nextStatus);
    api.listDocuments(params).then(onPage).catch(() => {
      // The regular refresh path will surface API errors elsewhere.
    });
  }, [statusTarget.version, onStatusTargetApplied]);

  async function deleteDocument(document: IncomingDocument) {
    await api.deleteDocument(document._id);
    setDeleteTarget(null);
    const nextPage = documents.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
    await loadPage(nextPage);
  }

  async function reprocessDocument(document: IncomingDocument, payload: ReprocessDocumentPayload) {
    await api.reprocessDocument(document._id, payload);
    setReprocessTarget(null);
    await loadPage(pagination.page);
  }

  async function reclassifyDocument(document: IncomingDocument, documentTypeId: string) {
    if (!documentTypeId) return;
    await api.reclassifyDocument(document._id, documentTypeId);
    setReclassifyTarget(null);
    setReclassifyDocumentType('');
    await loadPage(pagination.page);
  }

  async function resetFilters() {
    const nextStatus = '';
    const nextCategory = '';
    const nextNameFilter = '';
    const nextSort = 'latest';
    const nextPageSize = 10;

    setStatus(nextStatus);
    setCategory(nextCategory);
    setNameFilter(nextNameFilter);
    setSort(nextSort);
    setPageSize(nextPageSize);

    const params = new URLSearchParams({
      sort: nextSort,
      page: String(1),
      pageSize: String(nextPageSize),
    });
    onPage(await api.listDocuments(params));
  }

  return (
    <section className="panel document-list-panel">
      <div className="panel-heading document-list-heading">
        <div>
          <h2 className="document-workspace-title"><Files size={18} /> Document workspace</h2>
        </div>
        <div className="panel-heading-actions">
          <span className="document-total-badge"><strong>{pagination.total}</strong> total documents</span>
          <button className="icon-button" title="Refresh document list" onClick={() => loadPage(pagination.page)}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="document-filter-panel">
        <div className="document-filter-heading">
          <span><FileSearch size={15} /> Filter documents</span>
          {(status || category || nameFilter) && <em>Filters active</em>}
        </div>
        <div className="filters">
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as DocumentStatusFilter)}>
            <option value="">All</option>
            <option value="in-progress">In progress</option>
            <option value="received">Received</option>
            <option value="preprocessed">Preprocessed</option>
            <option value="classified">Classified</option>
            <option value="extracted">Extracted</option>
            <option value="validated">Validated</option>
            <option value="rejected">Rejected</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label>
          Document name
          <input
            type="text"
            placeholder="Search by name"
            value={nameFilter}
            onChange={(event) => setNameFilter(event.target.value)}
          />
        </label>
        <label>
          Category
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="">All</option>
            {categories.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="latest">Latest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <label>
          Page size
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </label>
        <button className="secondary-button compact" onClick={applyFilters}>
          Apply
        </button>
        <button className="secondary-button compact" onClick={resetFilters}>
          Reset
        </button>
        </div>
      </div>

      <div className="document-table">
        {documents.map((doc) => (
          <div className="document-row" key={doc._id}>
            <button className="document-open" onClick={() => onOpen(doc._id)}>
              <span className="document-primary-info">
                <span className="document-file-icon"><DocumentFileTypeIcon document={doc} /></span>
                <span>
                  <strong>{doc.originalName}</strong>
                  {doc.validatedBy && (
                    <small className="document-validator">
                      <ShieldCheck size={12} /> Validated by {doc.validatedBy.username}
                    </small>
                  )}
                  {doc.rejectedBy && (
                    <small className="document-reviewer rejected">
                      <CircleX size={12} /> Rejected by {doc.rejectedBy.username}
                    </small>
                  )}
                </span>
              </span>
              <span className="document-type-capsule">
                <span>{doc.category}</span>
                <i>/</i>
                <strong>{doc.documentTypeName}</strong>
              </span>
              <span
                className={`pill ${doc.status} clickable-status`}
                role="button"
                tabIndex={0}
                title="View document processing flow"
                onClick={(event) => {
                  event.stopPropagation();
                  setFlowTarget(doc);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  setFlowTarget(doc);
                }}
              >
                {doc.status}
              </span>
              <span className={`score-badge${scoreToneClass(doc.classificationScore)}`}>
                {formatScore(doc.classificationScore)}
                <ClassificationMethodIcon
                  method={doc.classificationMethod}
                  onShowJustification={doc.classificationMethod === 'llm' || doc.classificationMethod === 'rag' || doc.classificationMethod === 'vector' ? () => setJustificationTarget(doc) : undefined}
                />
              </span>
              <span className="processing-mode-badge">
                <ProcessingModeIcon mode={doc.processingMode} />
                {doc.processingMode ? doc.processingMode.toUpperCase() : 'N/A'}
              </span>
              <time>{new Date(doc.createdAt).toLocaleString()}</time>
            </button>
            {canManage && (
              <div className="row-actions">
                <button
                  className="icon-button locked-action"
                  title={doc.status === 'validated' || doc.status === 'rejected' ? 'Reclassification is not allowed for locked documents' : 'Reclassify document'}
                  disabled={doc.status === 'validated' || doc.status === 'rejected'}
                  onClick={(event) => {
                    event.stopPropagation();
                    setReclassifyTarget(doc);
                    const docCategory = doc.category;
                    setReclassifyCategory(docCategory);
                    setReclassifyDocumentType(doc.documentTypeId || '');
                  }}
                >
                  <BrainCircuit size={16} />
                  {(doc.status === 'validated' || doc.status === 'rejected') && <CircleX className="not-allowed-mark" size={12} />}
                </button>
                <button
                  className="icon-button locked-action"
                  title={doc.status === 'validated' || doc.status === 'rejected' ? 'Reprocessing is not allowed for locked documents' : 'Reprocess document'}
                  disabled={doc.status === 'validated' || doc.status === 'rejected'}
                  onClick={(event) => {
                    event.stopPropagation();
                    setReprocessTarget(doc);
                  }}
                >
                  <RotateCcw size={16} />
                  {(doc.status === 'validated' || doc.status === 'rejected') && <CircleX className="not-allowed-mark" size={12} />}
                </button>
                <button
                  className="icon-button danger"
                  title="Delete document"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTarget(doc);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete Document"
          body={`Delete "${deleteTarget.originalName}" and its uploaded file?`}
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteDocument(deleteTarget)}
        />
      )}

      {justificationTarget && (
        <ClassificationJustificationDialog document={justificationTarget} onClose={() => setJustificationTarget(null)} />
      )}

      {flowTarget && <DocumentFlowDialog document={flowTarget} onClose={() => setFlowTarget(null)} />}

      {reprocessTarget && (
        <ReprocessDialog
          document={reprocessTarget}
          documentType={documentTypes.find((type) => type._id === reprocessTarget.documentTypeId)}
          config={config}
          onCancel={() => setReprocessTarget(null)}
          onConfirm={(payload) => reprocessDocument(reprocessTarget, payload)}
        />
      )}

      {reclassifyTarget && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setReclassifyTarget(null)}>
          <section className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <h2>Reclassify Document</h2>
                <p>{reclassifyTarget.originalName}</p>
              </div>
              <button className="icon-button" title="Close" onClick={() => setReclassifyTarget(null)}>
                <X size={17} />
              </button>
            </div>
            <label>
              Category
              <select value={reclassifyCategory} onChange={(e) => {
                setReclassifyCategory(e.target.value);
                setReclassifyDocumentType('');
              }}>
                <option value="">Choose a category...</option>
                {categories.map((cat) => (
                  <option key={cat}>{cat}</option>
                ))}
              </select>
            </label>
            <label>
              Document Type
              <select value={reclassifyDocumentType} onChange={(e) => setReclassifyDocumentType(e.target.value)} disabled={!reclassifyCategory}>
                <option value="">Choose a document type...</option>
                {reclassifyAvailableTypes.map((type) => (
                  <option key={type._id} value={type._id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-footer">
              <button className="secondary-button" onClick={() => setReclassifyTarget(null)}>
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!reclassifyDocumentType}
                onClick={() => reclassifyDocument(reclassifyTarget, reclassifyDocumentType)}
              >
                <BrainCircuit size={16} />
                Reclassify
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="pager">
        <span>
          Showing {documents.length ? (pagination.page - 1) * pagination.pageSize + 1 : 0}
          {' - '}
          {Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}
        </span>
        <div className="pager-controls">
          <button className="secondary-button compact" disabled={pagination.page <= 1} onClick={() => loadPage(pagination.page - 1)}>
            Previous
          </button>
          <strong>
            Page {pagination.page} / {pagination.totalPages}
          </strong>
          <button
            className="secondary-button compact"
            disabled={pagination.page >= pagination.totalPages}
            onClick={() => loadPage(pagination.page + 1)}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  confirmIcon,
  confirmDisabled = false,
  isDanger = true,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string | JSX.Element;
  confirmLabel: string;
  confirmIcon?: JSX.Element;
  confirmDisabled?: boolean;
  isDanger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="confirm-modal">
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {typeof body === 'string' ? <p>{body}</p> : <div className="confirm-dialog-body">{body}</div>}
          </div>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <X size={17} />
          </button>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button className={`primary-button${isDanger ? ' danger-action' : ''}`} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmIcon || <Trash2 size={16} />}
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function formatStageTimestamp(value?: string) {
  return value ? new Date(value).toLocaleString() : '—';
}

function formatStageDuration(startTime?: string, endTime?: string) {
  if (!startTime) return '—';
  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatDurationMilliseconds(duration: number) {
  const totalSeconds = Math.max(0, Math.round(duration / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function DocumentFlowDialog({
  document,
  onClose,
}: {
  document: IncomingDocument;
  onClose: () => void;
}) {
  const baseStatuses: IncomingDocument['status'][] = ['received', 'preprocessed', 'classified', 'extracted'];
  const recordedTimings = document.stageTimings || [];
  const optionalStatuses: IncomingDocument['status'][] = ['validated', 'rejected', 'failed'];
  const statuses = [
    ...baseStatuses,
    ...optionalStatuses.filter((status) =>
      status === document.status || recordedTimings.some((timing) => timing.status === status)),
  ];
  const processingTimings = baseStatuses
    .map((status) => [...recordedTimings].reverse().find((timing) => timing.status === status))
    .filter((timing): timing is NonNullable<typeof timing> => Boolean(timing?.startTime));
  const now = Date.now();
  const processingTimeExcludingQueue = processingTimings.reduce((total, timing) => {
    const start = new Date(timing.startTime).getTime();
    const end = timing.endTime
      ? new Date(timing.endTime).getTime()
      : timing.status === document.status
        ? now
        : start;
    return total + Math.max(0, end - start);
  }, 0);
  const processingStart = processingTimings.length
    ? Math.min(...processingTimings.map((timing) => new Date(timing.startTime).getTime()))
    : now;
  const extractedTiming = [...recordedTimings].reverse().find((timing) => timing.status === 'extracted');
  const latestRecordedTime = recordedTimings.length
    ? Math.max(...recordedTimings.flatMap((timing) => [
      new Date(timing.startTime).getTime(),
      timing.endTime ? new Date(timing.endTime).getTime() : now,
    ]))
    : now;
  const processingEnd = extractedTiming?.endTime
    ? new Date(extractedTiming.endTime).getTime()
    : latestRecordedTime;
  const processingTimeIncludingQueue = Math.max(0, processingEnd - processingStart);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="confirm-modal document-flow-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <h2>Document flow</h2>
            <p>{document.originalName}</p>
          </div>
          <button className="icon-button" title="Close document flow" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="document-flow-summary">
          <div>
            <span>Processing time</span>
            <strong>{formatDurationMilliseconds(processingTimeExcludingQueue)}</strong>
            <small>Function execution only</small>
          </div>
          <div>
            <span>Total elapsed time</span>
            <strong>{formatDurationMilliseconds(processingTimeIncludingQueue)}</strong>
            <small>Including queue wait</small>
          </div>
        </div>
        <div className="document-flow">
          {statuses.map((status, index) => {
            const timing = [...recordedTimings].reverse().find((item) => item.status === status);
            const nextStatus = statuses[index + 1];
            const nextTiming = nextStatus
              ? [...recordedTimings].reverse().find((item) => item.status === nextStatus)
              : undefined;
            const showQueueWait = index < baseStatuses.length - 1
              && Boolean(timing?.endTime && (nextTiming?.startTime || document.status === status));
            const isCurrent = status === document.status;
            const isTerminalStatus = status === 'validated' || status === 'rejected' || status === 'failed';
            const completed = Boolean(timing?.endTime) || (isCurrent && isTerminalStatus);
            return (
              <Fragment key={status}>
                <div className={`document-flow-stage ${status}${isCurrent ? ' current' : ''}${completed ? ' completed' : ''}`}>
                  <div className="document-flow-marker">
                    {completed ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}
                    {index < statuses.length - 1 && <span />}
                  </div>
                  <div className="document-flow-stage-card">
                    <div className="document-flow-stage-heading">
                      <strong>{status}</strong>
                      <span>{completed ? 'Completed' : isCurrent ? 'In progress' : timing ? 'Started' : 'Not started'}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>Start time</dt>
                        <dd>{formatStageTimestamp(timing?.startTime)}</dd>
                      </div>
                      <div>
                        <dt>End time</dt>
                        <dd>{formatStageTimestamp(timing?.endTime)}</dd>
                      </div>
                      <div>
                        <dt>Duration</dt>
                        <dd>{formatStageDuration(timing?.startTime, timing?.endTime)}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
                {showQueueWait && (
                  <div className="document-queue-wait">
                    <div className="document-queue-wait-icon">
                      <Clock3 size={16} />
                    </div>
                    <div>
                      <strong>Queue wait for {nextStatus}</strong>
                      <span>
                        {formatStageTimestamp(timing?.endTime)}
                        {' → '}
                        {nextTiming?.startTime ? formatStageTimestamp(nextTiming.startTime) : 'Waiting'}
                      </span>
                    </div>
                    <em>{formatStageDuration(timing?.endTime, nextTiming?.startTime)}</em>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ReprocessDialog({
  document,
  documentType,
  config,
  onCancel,
  onConfirm,
}: {
  document: IncomingDocument;
  documentType?: DocumentType;
  config: AppConfig;
  onCancel: () => void;
  onConfirm: (payload: ReprocessDocumentPayload) => Promise<void> | void;
}) {
  const initialMode: ReprocessProcessingMode =
    document.processingMode || (config.useOcrForDocumentProcessing
      ? config.documentTextMode === 'markdown' ? 'markdown' : 'ocr'
      : 'pdf');
  const [extractionModel, setExtractionModel] = useState(
    document.processingMetrics?.model || documentType?.extractionModel || lowCostOpenAIModel,
  );
  const reprocessModelOptions = openAIModelOptions.some((option) => option.value === extractionModel)
    ? openAIModelOptions
    : [{ value: extractionModel, label: displayModel(extractionModel) }, ...openAIModelOptions];
  const [processingMode, setProcessingMode] = useState<ReprocessProcessingMode>(initialMode);
  const [submitting, setSubmitting] = useState(false);

  async function confirm() {
    setSubmitting(true);
    try {
      await onConfirm({
        extractionModel,
        useOcrForDocumentProcessing: processingMode !== 'pdf',
        documentTextMode: processingMode === 'markdown' ? 'markdown' : 'ocr',
        forceClassification: true,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onCancel}>
      <section className="confirm-modal reprocess-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <h2>Reprocess Document</h2>
            <p>{document.originalName}</p>
          </div>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <X size={17} />
          </button>
        </div>
        <div className="reprocess-options">
          <label>
            Extraction model
            <select value={extractionModel} onChange={(event) => setExtractionModel(event.target.value)}>
              {reprocessModelOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            OCR / text engine
            <select value={processingMode} onChange={(event) => setProcessingMode(event.target.value as ReprocessProcessingMode)}>
              <option value="pdf">PDF direct</option>
              <option value="ocr">Built in OCR/text</option>
              <option value="markdown">Markdown (Docling service)</option>
            </select>
          </label>
        </div>
        {processingMode === 'markdown' && !config.markdownServiceUrl && (
          <p className="warning-text">
            Markdown processing uses the configured Docling service URL. Configure it before using this option.
          </p>
        )}
        <div className="modal-footer">
          <button className="secondary-button" type="button" disabled={submitting} onClick={onCancel}>
            Cancel
          </button>
          <button className="primary-button" type="button" disabled={submitting} onClick={confirm}>
            {submitting ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}
            Reprocess
          </button>
        </div>
      </section>
    </div>
  );
}

function ValidationScreen({
  documentId,
  documentTypes,
  config,
  canNavigatePrevious = false,
  canNavigateNext = false,
  onNavigatePrevious,
  onNavigateNext,
  onRefresh,
  onValidated,
  onNotify,
  canAdminActions = false,
}: {
  documentId: string;
  documentTypes: DocumentType[];
  config: AppConfig;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
  onNavigatePrevious: (currentDocumentId: string) => Promise<boolean>;
  onNavigateNext: (currentDocumentId: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onValidated: (notification: string) => Promise<void>;
  onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void;
  canAdminActions?: boolean;
}) {
  const [document, setDocument] = useState<IncomingDocument | null>(null);
  const [values, setValues] = useState<ExtractedValue[]>([]);
  const [tableEditIndex, setTableEditIndex] = useState<number | null>(null);
  const [editingValueKey, setEditingValueKey] = useState<string | null>(null);
  const [editingValueDraft, setEditingValueDraft] = useState('');
  const [savingValueKey, setSavingValueKey] = useState<string | null>(null);
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null);
  const [showClassificationJustification, setShowClassificationJustification] = useState(false);
  const [showDocumentFlow, setShowDocumentFlow] = useState(false);
  const [showReclassifyDialog, setShowReclassifyDialog] = useState(false);
  const [showReprocessDialog, setShowReprocessDialog] = useState(false);
  const [reclassifyCategory, setReclassifyCategory] = useState('');
  const [reclassifyDocumentType, setReclassifyDocumentType] = useState('');
  const [pendingValidationAction, setPendingValidationAction] = useState<'validate' | 'reject' | null>(null);
  const [navigationPending, setNavigationPending] = useState(false);
  const documentTypeFor = (doc: IncomingDocument) => documentTypes.find((type) => type._id === doc.documentTypeId);

  function applyDocumentState(nextDocument: IncomingDocument) {
    const normalizedValues = normalizeExtractedDataToSchema(nextDocument.extractedData, documentTypeFor(nextDocument));
    setDocument({ ...nextDocument, extractedData: normalizedValues });
    setValues(normalizedValues);
    setReclassifyCategory(nextDocument.category);
    setReclassifyDocumentType(nextDocument.documentTypeId || '');
    return normalizedValues;
  }

  async function refreshPage() {
    if (!documentId) return;
    const refreshed = await api.getDocument(documentId);
    applyDocumentState(refreshed);
    await onRefresh();
    onNotify('Validation page refreshed');
  }

  const categories = Array.from(new Set(documentTypes.map((type) => type.category))).sort();
  const reclassifyAvailableTypes = documentTypes.filter((type) => type.category === reclassifyCategory);

  const fieldStyles = useMemo(() => {
    return values.reduce<Record<string, { border: string; fill: string; activeFill: string }>>((acc, item, index) => {
      const hue = (index * 47 + 12) % 360;
      acc[item.key] = {
        border: `hsl(${hue}, 88%, 47%)`,
        fill: `hsla(${hue}, 95%, 80%, 0.32)`,
        activeFill: `hsla(${hue}, 95%, 70%, 0.42)`,
      };
      return acc;
    }, {});
  }, [values]);

  const pdfHighlights = useMemo(() => {
    return values.flatMap((item) => {
      const styles = fieldStyles[item.key];
      return (item.boundingBoxes || []).map((box) => ({
        ...box,
        fieldKey: item.key,
        color: styles?.border || 'rgba(59, 130, 246, 0.8)',
        activeFill: styles?.activeFill || 'rgba(59, 130, 246, 0.25)',
      }));
    });
  }, [fieldStyles, values]);

  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    setDocument(null);
    setValues([]);
    setActiveFieldKey(null);
    setEditingValueKey(null);
    setEditingValueDraft('');
    setSavingValueKey(null);
    api.getDocument(documentId).then((doc) => {
      if (cancelled) return;
      applyDocumentState(doc);
    }).catch((error) => {
      if (!cancelled) onNotify(error instanceof Error ? error.message : 'Failed to load document', 'error');
    });

    return () => {
      cancelled = true;
    };
  }, [documentId, documentTypes]);

  async function navigateDocument(direction: 'previous' | 'next') {
    if (!document) return;
    if (navigationPending) return;
    const currentDocumentId = document._id;
    setNavigationPending(true);
    setDocument(null);
    setValues([]);
    try {
      const moved = await (direction === 'previous' ? onNavigatePrevious(currentDocumentId) : onNavigateNext(currentDocumentId));
      if (!moved) {
        const currentDocument = await api.getDocument(currentDocumentId);
        applyDocumentState(currentDocument);
      }
    } finally {
      setNavigationPending(false);
    }
  }

  function startValueEdit(item: ExtractedValue) {
    setActiveFieldKey(item.key);
    setEditingValueKey(item.key);
    setEditingValueDraft(coerceValue(item.value));
  }

  function cancelValueEdit() {
    setEditingValueKey(null);
    setEditingValueDraft('');
  }

  async function persistExtractedData(nextValues: ExtractedValue[]) {
    if (!document) return;
    const updated = await api.updateExtractedData(document._id, nextValues);
    const normalizedValues = normalizeExtractedDataToSchema(updated.extractedData, documentTypeFor(updated));
    setDocument({ ...updated, extractedData: normalizedValues });
    setValues(normalizedValues);
  }

  async function saveValueEdit(index: number) {
    if (!document || savingValueKey) return;
    const current = values[index];
    if (!current) return;

    const next = [...values];
    next[index] = { ...current, value: editingValueDraft };

    setSavingValueKey(current.key);
    try {
      await persistExtractedData(next);
      cancelValueEdit();
      onNotify(`${current.label} saved`, 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to save value', 'error');
    } finally {
      setSavingValueKey(null);
    }
  }

  async function updateTableValue(index: number, value: Record<string, unknown>[]) {
    const next = [...values];
    next[index] = { ...next[index], value };
    await persistExtractedData(next);
  }

  async function submit() {
    if (!document) return;
    setPendingValidationAction(null);
    const normalized = values.map((item) => {
      if (item.type !== 'table') return item;
      try {
        return { ...item, value: JSON.parse(String(item.value)) };
      } catch {
        return item;
      }
    });
    await api.validateDocument(document._id, normalized);
    const message = `Document validated: ${document.originalName}`;
    onNotify(message, 'success');
    await onValidated(message);
  }

  async function reject() {
    if (!document) return;
    setPendingValidationAction(null);
    await api.rejectDocument(document._id);
    const message = `Document rejected: ${document.originalName}`;
    onNotify(message, 'error');
    await onValidated(message);
  }

  async function reclassify() {
    if (!document || !reclassifyDocumentType) return;
    await api.reclassifyDocument(document._id, reclassifyDocumentType);
    setShowReclassifyDialog(false);
    const message = `Document reclassified: ${document.originalName}`;
    onNotify(message, 'info');
    await onValidated(message);
  }

  async function reprocess(payload: ReprocessDocumentPayload) {
    if (!document) return;
    const updated = await api.reprocessDocument(document._id, payload);
    setShowReprocessDialog(false);
    const message = `Document reprocessing started: ${document.originalName}`;
    applyDocumentState(updated);
    onNotify(message, 'info');
    await onRefresh();
  }

  function downloadExtractedJson() {
    if (!document) return;
    const normalizedValues = normalizeExtractedDataToSchema(values, documentTypeFor(document));
    downloadJsonFile(`${document.originalName.replace(/\.[^.]+$/, '') || document.fileName}-extracted-data.json`, {
      documentId: document._id,
      fileName: document.originalName,
      category: document.category,
      documentTypeId: document.documentTypeId,
      documentTypeName: document.documentTypeName,
      classificationScore: document.classificationScore,
      classificationMethod: document.classificationMethod,
      classificationModel: document.classificationModel,
      extractionModel: document.processingMetrics?.model,
      processingMode: document.processingMode,
      status: document.status,
      validatedBy: document.validatedBy,
      validatedAt: document.validatedAt,
      rejectedBy: document.rejectedBy,
      rejectedAt: document.rejectedAt,
      extractedData: normalizedValues,
      exportedAt: new Date().toISOString(),
    });
    onNotify('JSON downloaded', 'success');
  }

  async function downloadPdf() {
    if (!document) return;
    try {
      const displayName = document.originalName || document.fileName || 'document.pdf';
      const processingPdfName = `${displayName.replace(/\.[^.]+$/, '') || 'document'}.pdf`;
      downloadBlobFile(processingPdfName, await api.documentFile(document._id));
      onNotify('Processing PDF downloaded', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to download PDF', 'error');
    }
  }

  async function downloadTextArtifact() {
    if (!document) return;
    try {
      const mode = document.textArtifactMode === 'markdown' ? 'markdown' : 'ocr';
      const extension = mode === 'markdown' ? 'md' : 'ocr';
      const baseName = document.originalName.replace(/\.[^.]+$/, '') || document.fileName.replace(/\.[^.]+$/, '') || 'document';
      downloadBlobFile(`${baseName}.${extension}`, await api.documentTextArtifact(document._id));
      onNotify(`${mode === 'markdown' ? 'Markdown' : 'OCR'} file downloaded`, 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to download OCR/markdown file', 'error');
    }
  }

  if (!documentId) return <EmptyState text="Select a document from the list." />;
  if (!document) return <EmptyState text="Loading document." />;

  const isLocked = document.status === 'validated' || document.status === 'rejected';

  return (
    <div className="validation-layout">
      <section className="pdf-pane">
        <PdfViewer
          documentId={document._id}
          highlights={pdfHighlights}
          activeFieldKey={activeFieldKey}
        />
      </section>
      <section className="panel extraction-pane">
        <div className="extraction-pane-content">
          <div className="panel-heading">
            <div>
              <h2>{document.originalName}</h2>
              <span className="document-type-capsule validation-document-type-capsule">
                <span>{document.category}</span>
                <i>/</i>
                <strong>{document.documentTypeName}</strong>
              </span>
              <div className="classification-score-line">
                <span>Classification score</span>
                <strong className={scoreToneClass(document.classificationScore).trim() || undefined}>
                  {formatScore(document.classificationScore)}
                </strong>
                <ClassificationMethodIcon
                  method={document.classificationMethod}
                  onShowJustification={document.classificationMethod === 'llm' || document.classificationMethod === 'rag' || document.classificationMethod === 'vector' ? () => setShowClassificationJustification(true) : undefined}
                />
              </div>
              <div className="document-model-line">
                <span>Classification: {displayModel(document.classificationModel)}</span>
                <span>Extraction: {displayModel(document.processingMetrics?.model)}</span>
              </div>
              {document.validatedBy && (
                <div className="validation-audit-line">
                  <ShieldCheck size={14} />
                  <span>Validated by <strong>{document.validatedBy.username}</strong></span>
                  {document.validatedAt && <time>{new Date(document.validatedAt).toLocaleString()}</time>}
                </div>
              )}
              {document.rejectedBy && (
                <div className="validation-audit-line rejected">
                  <CircleX size={14} />
                  <span>Rejected by <strong>{document.rejectedBy.username}</strong></span>
                  {document.rejectedAt && <time>{new Date(document.rejectedAt).toLocaleString()}</time>}
                </div>
              )}
            </div>
            <div className="panel-heading-actions">
              <div className="validation-header-badges">
                <button
                  type="button"
                  className={`pill ${document.status} clickable-status`}
                  title="View document processing flow"
                  onClick={() => setShowDocumentFlow(true)}
                >
                  {document.status}
                </button>
                <span className="processing-mode-badge">
                  <ProcessingModeIcon mode={document.processingMode} />
                  {document.processingMode ? document.processingMode.toUpperCase() : 'N/A'}
                </span>
              </div>
              <button className="icon-button validation-refresh-button" title="Refresh validation page" onClick={refreshPage}>
                <RefreshCw size={16} />
              </button>
              <button className="icon-button" title="Download processing PDF" onClick={downloadPdf}>
                <FileText size={16} />
              </button>
              <button
                className="icon-button"
                title={`Download ${document.textArtifactMode === 'markdown' ? 'markdown' : 'OCR'} file`}
                onClick={downloadTextArtifact}
                disabled={!document.textArtifactBlobName}
              >
                <ScanText size={16} />
              </button>
              <button className="icon-button" title="Download extracted data as JSON" onClick={downloadExtractedJson}>
                <Download size={16} />
              </button>
            </div>
          </div>
          {showDocumentFlow && (
            <DocumentFlowDialog document={document} onClose={() => setShowDocumentFlow(false)} />
          )}
          <div className="extraction-form">
            {values.map((item, index) => {
              const styles = fieldStyles[item.key];
              const isActive = item.key === activeFieldKey;
              const isMissingValue = !hasExtractedValue(item);
              const isLowConfidence = typeof item.confidence === 'number' && item.confidence < 0.8;
              const badge = confidenceBadge(item);
              const fieldClassName = [
                'extraction-field',
                isActive ? 'active' : '',
                isMissingValue || isLowConfidence ? 'low-score' : '',
                isMissingValue ? 'missing-value' : '',
              ].filter(Boolean).join(' ');
              const wrapperStyle = {
                borderColor: isMissingValue || isLowConfidence ? 'rgba(185, 28, 28, 0.45)' : styles?.border,
                backgroundColor: isMissingValue
                  ? 'rgba(248, 113, 113, 0.1)'
                  : isActive
                    ? styles?.activeFill
                    : styles?.fill,
              } as const;

              const isEditingValue = editingValueKey === item.key;
              const isSavingValue = savingValueKey === item.key;

              return item.type === 'table' ? (
                <div
                  className={fieldClassName}
                  key={item.key}
                  style={wrapperStyle}
                >
                  <div className="field-label">
                    <button className="value-link" onClick={() => setActiveFieldKey(item.key)}>
                      {item.label}
                    </button>
                    {badge && (
                      <em className={isLowClassificationScore(item.confidence) ? 'low-score' : undefined}>
                        {badge}
                      </em>
                    )}
                  </div>
                  <TableValuePreview item={item} canEdit={!isLocked} onEdit={() => setTableEditIndex(index)} />
                </div>
              ) : (
                <div
                  key={item.key}
                  className={fieldClassName}
                  style={wrapperStyle}
                >
                  <div className="field-label">
                    <button className="value-link" type="button" onClick={() => setActiveFieldKey(item.key)}>
                      {item.label}
                    </button>
                    {badge && (
                      <em className={isLowClassificationScore(item.confidence) ? 'low-score' : undefined}>
                        {badge}
                      </em>
                    )}
                  </div>
                  <div className="value-editor">
                    <input
                      aria-label={`${item.label} value`}
                      value={isEditingValue ? editingValueDraft : coerceValue(item.value)}
                      readOnly={!isEditingValue}
                      disabled={isLocked}
                      autoFocus={isEditingValue}
                      onChange={(event) => setEditingValueDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (!isEditingValue) return;
                        if (isSavingValue) return;
                        if (event.key === 'Enter') saveValueEdit(index);
                        if (event.key === 'Escape') cancelValueEdit();
                      }}
                    />
                    <div className="value-editor-actions">
                      {isEditingValue ? (
                        <>
                          <button
                            className="icon-button"
                            type="button"
                            title="Save value"
                            disabled={isSavingValue}
                            onClick={() => saveValueEdit(index)}
                          >
                            {isSavingValue ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
                          </button>
                          <button className="icon-button" type="button" title="Cancel edit" disabled={isSavingValue} onClick={cancelValueEdit}>
                            <X size={15} />
                          </button>
                        </>
                      ) : (
                        !isLocked && (
                          <button className="icon-button" type="button" title="Edit value" onClick={() => startValueEdit(item)}>
                            <Pencil size={15} />
                          </button>
                        )
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {isLocked && (
            <div className={`locked-state ${document.status}`}>
              {document.status === 'validated' ? <CheckCircle2 size={16} /> : <X size={16} />}
              {document.status === 'validated' ? 'Validated' : 'Rejected'} documents are locked.
            </div>
          )}
        </div>
        <div className="extraction-pane-footer">
            <div className="validation-actions">
              <button
                className="icon-button"
                type="button"
                title="Previous document"
                aria-label="Previous document"
                disabled={!canNavigatePrevious || navigationPending}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  navigateDocument('previous');
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                className="icon-button"
                type="button"
                title="Next document"
                aria-label="Next document"
                disabled={!canNavigateNext || navigationPending}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  navigateDocument('next');
                }}
              >
                <ChevronRight size={16} />
              </button>
              {canAdminActions && (
                <>
                  <button
                    className="icon-button locked-action"
                    type="button"
                    title={isLocked ? 'Reclassification is not allowed for locked documents' : 'Reclassify document'}
                    aria-label="Reclassify document"
                    disabled={isLocked}
                    onClick={() => setShowReclassifyDialog(true)}
                  >
                    <BrainCircuit size={16} />
                    {isLocked && <CircleX className="not-allowed-mark" size={12} />}
                  </button>
                  <button
                    className="icon-button locked-action"
                    type="button"
                    title={isLocked ? 'Reprocessing is not allowed for locked documents' : 'Reprocess document'}
                    aria-label="Reprocess document"
                    disabled={isLocked}
                    onClick={() => setShowReprocessDialog(true)}
                  >
                    <RotateCcw size={16} />
                    {isLocked && <CircleX className="not-allowed-mark" size={12} />}
                  </button>
                </>
              )}
              {!isLocked && (
                <>
                  <button className="secondary-button danger-outline" type="button" onClick={() => setPendingValidationAction('reject')}>
                    <X size={16} />
                    Reject
                  </button>
                  <button className="primary-button" type="button" onClick={() => setPendingValidationAction('validate')}>
                    <CheckCircle2 size={16} />
                    Validate
                  </button>
                </>
              )}
            </div>
          </div>
      </section>
      {tableEditIndex !== null && values[tableEditIndex] && (
        <TableEditDialog
          item={values[tableEditIndex]}
          onClose={() => setTableEditIndex(null)}
          onSave={async (rows) => {
            try {
              const label = values[tableEditIndex].label;
              await updateTableValue(tableEditIndex, rows);
              setTableEditIndex(null);
              onNotify(`${label} saved`, 'success');
            } catch (error) {
              onNotify(error instanceof Error ? error.message : 'Failed to save table', 'error');
            }
          }}
        />
      )}
      {pendingValidationAction && document && (
        <ConfirmDialog
          title={pendingValidationAction === 'validate' ? 'Validate Document' : 'Reject Document'}
          body={
            pendingValidationAction === 'validate'
              ? `Submit validation for "${document.originalName}"?`
              : `Reject "${document.originalName}"?`
          }
          confirmLabel={pendingValidationAction === 'validate' ? 'Validate' : 'Reject'}
          confirmIcon={pendingValidationAction === 'validate' ? <CheckCircle2 size={16} /> : <X size={16} />}
          isDanger={pendingValidationAction === 'reject'}
          onCancel={() => setPendingValidationAction(null)}
          onConfirm={pendingValidationAction === 'validate' ? submit : reject}
        />
      )}
      {showReprocessDialog && document && (
        <ReprocessDialog
          document={document}
          documentType={documentTypeFor(document)}
          config={config}
          onCancel={() => setShowReprocessDialog(false)}
          onConfirm={reprocess}
        />
      )}
      {showClassificationJustification && document && (
        <ClassificationJustificationDialog document={document} onClose={() => setShowClassificationJustification(false)} />
      )}

      {showReclassifyDialog && document && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={() => setShowReclassifyDialog(false)}>
          <section className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <h2>Reclassify Document</h2>
                <p>{document.originalName}</p>
              </div>
              <button className="icon-button" title="Close" onClick={() => setShowReclassifyDialog(false)}>
                <X size={17} />
              </button>
            </div>
            <label>
              Category
              <select value={reclassifyCategory} onChange={(e) => {
                setReclassifyCategory(e.target.value);
                setReclassifyDocumentType('');
              }}>
                <option value="">Choose a category...</option>
                {categories.map((cat) => (
                  <option key={cat}>{cat}</option>
                ))}
              </select>
            </label>
            <label>
              Document Type
              <select value={reclassifyDocumentType} onChange={(e) => setReclassifyDocumentType(e.target.value)} disabled={!reclassifyCategory}>
                <option value="">Choose a document type...</option>
                {reclassifyAvailableTypes.map((type) => (
                  <option key={type._id} value={type._id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-footer">
              <button className="secondary-button" onClick={() => setShowReclassifyDialog(false)}>
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!reclassifyDocumentType}
                onClick={reclassify}
              >
                <BrainCircuit size={16} />
                Reclassify
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function PdfViewer({
  documentId,
  highlights,
  activeFieldKey,
}: {
  documentId: string;
  highlights: Array<{
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    fieldKey: string;
    color: string;
    activeFill: string;
  }>;
  activeFieldKey: string | null;
}) {
  const [selectedPage, setSelectedPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageImage, setPageImage] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const [pageError, setPageError] = useState('');
  const [zoom, setZoom] = useState(100);
  const [isPanning, setIsPanning] = useState(false);
  const pdfContainerRef = useRef<HTMLDivElement>(null);
  const panStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const minZoom = 60;
  const maxZoom = 180;
  const zoomStep = 20;

  function centerHighlightInPdfPane(highlightElement: HTMLElement) {
    const pagesContainer = pdfContainerRef.current;
    if (!pagesContainer) {
      highlightElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      return;
    }

    const paneRect = pagesContainer.getBoundingClientRect();
    const highlightRect = highlightElement.getBoundingClientRect();
    const scrollTop =
      pagesContainer.scrollTop + highlightRect.top - paneRect.top - pagesContainer.clientHeight / 2 + highlightRect.height / 2;
    const scrollLeft =
      pagesContainer.scrollLeft + highlightRect.left - paneRect.left - pagesContainer.clientWidth / 2 + highlightRect.width / 2;

    pagesContainer.scrollTo({
      top: Math.max(0, scrollTop),
      left: Math.max(0, scrollLeft),
      behavior: 'smooth',
    });
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const pagesContainer = pdfContainerRef.current;
    if (!pagesContainer) return;

    panStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: pagesContainer.scrollLeft,
      scrollTop: pagesContainer.scrollTop,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  }

  function movePan(event: ReactPointerEvent<HTMLDivElement>) {
    const panState = panStateRef.current;
    if (!panState || panState.pointerId !== event.pointerId) return;
    const pagesContainer = pdfContainerRef.current;
    if (!pagesContainer) return;

    pagesContainer.scrollLeft = panState.scrollLeft - (event.clientX - panState.startX);
    pagesContainer.scrollTop = panState.scrollTop - (event.clientY - panState.startY);
    event.preventDefault();
  }

  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    if (panStateRef.current?.pointerId === event.pointerId) {
      panStateRef.current = null;
      setIsPanning(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setSelectedPage(1);
    setPageCount(0);
    setPageImage(null);
    setPageError('');

    api.documentPageCount(documentId)
      .then(({ pageCount: count }) => {
        if (!cancelled) setPageCount(Math.max(count, 1));
      })
      .catch((error) => {
        if (!cancelled) setPageError(error instanceof Error ? error.message : 'Failed to load PDF page count.');
      });

    return () => {
      cancelled = true;
    };
  }, [documentId]);

  useEffect(() => {
    if (!pageCount) return;
    setSelectedPage((page) => Math.min(Math.max(page, 1), pageCount));
  }, [pageCount]);

  useEffect(() => {
    const selectedHighlights = highlights.filter((box) => box.fieldKey === activeFieldKey);
    if (selectedHighlights.length === 0) return;

    const targetPage = selectedHighlights[0].page + 1;
    if (targetPage > 0 && (!pageCount || targetPage <= pageCount)) {
      setSelectedPage(targetPage);
    }
  }, [activeFieldKey, highlights, pageCount]);

  useEffect(() => {
    if (!documentId || selectedPage < 1) return;
    let cancelled = false;
    let pdfTask: ReturnType<typeof getDocument> | null = null;

    setLoadingPage(true);
    setPageError('');
    setPageImage(null);

    (async () => {
      try {
        const pageBytes = await api.documentPageFile(documentId, selectedPage);
        if (cancelled) return;
        pdfTask = getDocument({ data: pageBytes });
        const pdf = await pdfTask.promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Unable to render PDF page.');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;
        const dataUrl = canvas.toDataURL('image/png');
        await pdf.destroy();
        if (!cancelled) {
          setPageImage({ dataUrl, width: viewport.width, height: viewport.height });
          setLoadingPage(false);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(error instanceof Error ? error.message : 'Failed to load PDF page.');
          setLoadingPage(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      pdfTask?.destroy();
    };
  }, [documentId, selectedPage]);

  useEffect(() => {
    if (!pdfContainerRef.current) return;
    if (!activeFieldKey || !pageImage) return;

    const activeHighlight = pdfContainerRef.current.querySelector('.pdf-highlight.active') as HTMLElement | null;
    if (!activeHighlight) return;

    centerHighlightInPdfPane(activeHighlight);
    setTimeout(() => activeHighlight.focus({ preventScroll: true }), 100);
  }, [activeFieldKey, pageImage, selectedPage, zoom]);

  const pageHighlights = highlights.filter((box) => box.page === selectedPage - 1);
  const canGoToPreviousPage = selectedPage > 1 && !loadingPage;
  const canGoToNextPage = Boolean(pageCount) && selectedPage < pageCount && !loadingPage;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar" aria-label="PDF page and zoom controls">
        <button
          className="icon-button"
          type="button"
          title="Previous PDF page"
          disabled={!canGoToPreviousPage}
          onClick={() => setSelectedPage((page) => Math.max(1, page - 1))}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="pdf-page-value">Page {selectedPage} / {pageCount || '-'}</span>
        <button
          className="icon-button"
          type="button"
          title="Next PDF page"
          disabled={!canGoToNextPage}
          onClick={() => setSelectedPage((page) => Math.min(pageCount || page, page + 1))}
        >
          <ChevronRight size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Zoom out"
          disabled={zoom <= minZoom}
          onClick={() => setZoom((value) => Math.max(minZoom, value - zoomStep))}
        >
          <ZoomOut size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          title="Reset zoom"
          disabled={zoom === 100}
          onClick={() => setZoom(100)}
        >
          <RotateCcw size={16} />
        </button>
        <span className="pdf-zoom-value">{zoom}%</span>
        <button
          className="icon-button"
          type="button"
          title="Zoom in"
          disabled={zoom >= maxZoom}
          onClick={() => setZoom((value) => Math.min(maxZoom, value + zoomStep))}
        >
          <ZoomIn size={16} />
        </button>
      </div>
      <div
        className={`pdf-pages${isPanning ? ' panning' : ''}`}
        ref={pdfContainerRef}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
      >
        {loadingPage && <div className="pdf-page-state">Loading page.</div>}
        {pageError && <div className="pdf-page-state error">{pageError}</div>}
        {pageImage && !loadingPage && !pageError && (
          <div
            className="pdf-page"
            key={selectedPage}
            style={{ aspectRatio: `${pageImage.width} / ${pageImage.height}`, width: `${zoom}%` }}
          >
            <img alt={`PDF page ${selectedPage}`} draggable={false} src={pageImage.dataUrl} />
            {pageHighlights.map((box, boxIndex) => {
              const isActive = box.fieldKey === activeFieldKey;
              return (
                <div
                  className={`pdf-highlight${isActive ? ' active' : ''}`}
                  key={`${selectedPage}-${boxIndex}`}
                  style={{
                    left: `${box.x * 100}%`,
                    top: `${box.y * 100}%`,
                    width: `${box.width * 100}%`,
                    height: `${box.height * 100}%`,
                    borderColor: box.color,
                    backgroundColor: isActive ? box.activeFill : 'transparent',
                    boxShadow: isActive ? `0 0 0 2px ${box.color}` : 'none',
                  }}
                  tabIndex={isActive ? 0 : -1}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function TableValuePreview({ item, canEdit, onEdit }: { item: ExtractedValue; canEdit: boolean; onEdit: () => void }) {
  const rows = asTableRows(item.value);
  const columns = tableColumns(rows);

  return (
    <div className="table-value">
      <div className="table-value-toolbar">
        <span>{rows.length} rows</span>
        {canEdit && (
          <button
            className="secondary-button compact"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onEdit();
            }}
          >
            <Pencil size={14} />
            Edit
          </button>
        )}
      </div>
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {columns.map((column) => (
                    <td key={column}>{coerceValue(row[column] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-table">No table rows extracted.</div>
      )}
    </div>
  );
}

function TableEditDialog({
  item,
  onClose,
  onSave,
}: {
  item: ExtractedValue;
  onClose: () => void;
  onSave: (rows: Record<string, unknown>[]) => void;
}) {
  const [rows, setRows] = useState<Record<string, unknown>[]>(() => asTableRows(item.value));
  const columns = tableColumns(rows);
  const editableColumns = columns.length ? columns : ['value'];

  function updateCell(rowIndex: number, column: string, value: string) {
    const next = [...rows];
    next[rowIndex] = { ...next[rowIndex], [column]: value };
    setRows(next);
  }

  function addRow() {
    const nextRow = Object.fromEntries(editableColumns.map((column) => [column, '']));
    setRows([...rows, nextRow]);
  }

  function addColumn() {
    const label = `column_${editableColumns.length + 1}`;
    setRows(rows.length ? rows.map((row) => ({ ...row, [label]: '' })) : [{ [label]: '' }]);
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal">
        <div className="modal-heading">
          <div>
            <h2>Edit {item.label}</h2>
            <p>Update extracted table cells before validation.</p>
          </div>
          <button className="icon-button" title="Close" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={addRow}>
            <PlusCircle size={16} />
            Row
          </button>
          <button className="secondary-button" onClick={addColumn}>
            <PlusCircle size={16} />
            Column
          </button>
        </div>

        <div className="editable-table">
          <table>
            <thead>
              <tr>
                {editableColumns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {editableColumns.map((column) => (
                    <td key={column}>
                      <input value={coerceValue(row[column] ?? '')} onChange={(event) => updateCell(rowIndex, column, event.target.value)} />
                    </td>
                  ))}
                  <td>
                    <button
                      className="icon-button danger"
                      title="Remove row"
                      onClick={() => setRows(rows.filter((_, index) => index !== rowIndex))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" onClick={() => onSave(rows)}>
            <Save size={16} />
            Save Table
          </button>
        </div>
      </section>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <section className="panel empty">
      <FileSearch size={24} />
      <p>{text}</p>
    </section>
  );
}
