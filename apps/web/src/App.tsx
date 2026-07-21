import { ChangeEvent, FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useState, useRef } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import Chart from 'chart.js/auto';
import {
  CheckCircle2,
  BarChart3,
  Building2,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ClipboardCheck,
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
  Sun,
  X,
  Trash2,
  Upload,
  Download,
  FileText,
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
import { api, AppConfigPayload, clearAuthToken, ReprocessDocumentPayload, saveAuthToken } from './api';
import { AuthUser, BusinessReviewSummary, DemoRequest, DisplayCurrency, DocumentType, ExtractedValue, ExtractionField, FieldType, IncomingDocument, PagedResult, ReasoningEffort, TableColumn, UserRole } from './types';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();

type View = 'types' | 'classification' | 'upload' | 'documents' | 'validation' | 'configuration' | 'business-review' | 'demo-requests' | 'password-reset' | 'users';

type AppConfig = AppConfigPayload;
type AiProvider = AppConfig['aiProvider'];
type EmbeddingProvider = AppConfig['embeddingProvider'];
type OperationsMetrics = {
  filesProcessed: number;
  totalCostUsd: number;
  filesProcessing: number;
  filesReady: number;
};
type DocumentStatusFilter = IncomingDocument['status'] | '';
type ReprocessProcessingMode = 'pdf' | 'ocr' | 'markdown';

const fieldTypes: FieldType[] = ['string', 'number', 'date', 'currency', 'boolean', 'table'];
const lowCostOpenAIModel = 'gpt-5-nano';
const defaultOllamaBaseUrl = 'http://127.0.0.1:11434';
const defaultOllamaModel = 'llama3.2';
const defaultOpenAIEmbeddingModel = 'text-embedding-3-small';
const defaultOllamaEmbeddingModel = 'qwen3-embedding:4b';
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
      <span className="method-icon vector" title="Vector classification" aria-label="Vector classification">
        <Network size={14} />
      </span>
    );
  }
  if (method === 'llm') {
    return (
      <span
        className={`method-icon llm${onShowJustification ? ' interactive' : ''}`}
        title={onShowJustification ? 'Show LLM classification justification' : 'LLM classification'}
        aria-label={onShowJustification ? 'Show LLM classification justification' : 'LLM classification'}
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
        <BrainCircuit size={14} />
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
    downstreamUrl: '',
    deleteAfterDownstream: false,
    sendKeyValuePairs: false,
    useOcrForDocumentProcessing: false,
    documentTextMode: 'ocr',
    markdownServiceUrl: '',
    aiProvider: 'openai',
    ollamaBaseUrl: defaultOllamaBaseUrl,
    ollamaModel: defaultOllamaModel,
    embeddingProvider: 'openai',
    embeddingModel: defaultOpenAIEmbeddingModel,
    ollamaEmbeddingModel: defaultOllamaEmbeddingModel,
    classificationModel: lowCostOpenAIModel,
    classificationReasoningEffort: 'low',
  });
  const isAdmin = currentUser?.role === 'admin';
  const canManageDocuments = currentUser?.role === 'admin' || currentUser?.role === 'validator';

  async function loadConfiguration() {
    try {
      const saved = await api.getConfiguration();
      setConfig({
        downstreamUrl: saved.downstreamUrl || '',
        deleteAfterDownstream: Boolean(saved.deleteAfterDownstream),
        sendKeyValuePairs: Boolean(saved.sendKeyValuePairs),
        useOcrForDocumentProcessing: Boolean(saved.useOcrForDocumentProcessing),
        documentTextMode: saved.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
        markdownServiceUrl: saved.markdownServiceUrl || '',
        aiProvider: saved.aiProvider === 'ollama' ? 'ollama' : 'openai',
        ollamaBaseUrl: saved.ollamaBaseUrl || defaultOllamaBaseUrl,
        ollamaModel: saved.ollamaModel || defaultOllamaModel,
        embeddingProvider: saved.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
        embeddingModel: saved.embeddingModel || defaultOpenAIEmbeddingModel,
        ollamaEmbeddingModel: saved.ollamaEmbeddingModel || defaultOllamaEmbeddingModel,
        classificationModel: saved.classificationModel || lowCostOpenAIModel,
        classificationReasoningEffort: saved.classificationReasoningEffort || 'low',
      });
    } catch {
      const storedConfig = localStorage.getItem('xtract-config');
      if (storedConfig) {
        try {
          const parsed = JSON.parse(storedConfig);
          setConfig({
            downstreamUrl: parsed.downstreamUrl || '',
            deleteAfterDownstream: Boolean(parsed.deleteAfterDownstream),
            sendKeyValuePairs: Boolean(parsed.sendKeyValuePairs),
            useOcrForDocumentProcessing: Boolean(parsed.useOcrForDocumentProcessing),
            documentTextMode: parsed.documentTextMode === 'markdown' ? 'markdown' : 'ocr',
            markdownServiceUrl: parsed.markdownServiceUrl || '',
            aiProvider: parsed.aiProvider === 'ollama' ? 'ollama' : 'openai',
            ollamaBaseUrl: parsed.ollamaBaseUrl || defaultOllamaBaseUrl,
            ollamaModel: parsed.ollamaModel || defaultOllamaModel,
            embeddingProvider: parsed.embeddingProvider === 'ollama' ? 'ollama' : 'openai',
            embeddingModel: parsed.embeddingModel || defaultOpenAIEmbeddingModel,
            ollamaEmbeddingModel: parsed.ollamaEmbeddingModel || defaultOllamaEmbeddingModel,
            classificationModel: parsed.classificationModel || lowCostOpenAIModel,
            classificationReasoningEffort: parsed.classificationReasoningEffort || 'low',
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
    const params = new URLSearchParams({
      sort: 'latest',
      page: String(documentPage.page),
      pageSize: String(documentPage.pageSize),
    });
    if (documentListStatusTarget.status) params.set('status', documentListStatusTarget.status);
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
    localStorage.setItem('xtract-config', JSON.stringify(config));
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

  async function handleLogin(username: string, password: string) {
    const session = await api.login({ username, password });
    saveAuthToken(session.token);
    setCurrentUser(session.user);
    setDisplayCurrency(normalizeDisplayCurrency(session.user.preferredCurrency));
    setView('documents');
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
    return <LoginScreen onLogin={handleLogin} />;
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
                  label="Processing"
                  value={operationsMetrics.filesProcessing}
                  onClick={() => openDocuments('processing')}
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
          <DemoRequestsScreen onNotify={showToast} />
        )}
        {!selectedPageLoading && isAdmin && view === 'users' && (
          <UserManagementScreen currentUser={currentUser} onNotify={showToast} />
        )}
        {!selectedPageLoading && view === 'password-reset' && (
          <PasswordResetScreen onNotify={showToast} />
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
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submitDemoRequest(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setStatus(null);
    try {
      await api.createDemoRequest({ email, phone, source: 'xtractor-marketing-site' });
      setEmail('');
      setPhone('');
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
        <div className="marketing-workflow-bg" aria-hidden="true">
          <span title="Intake"><Upload size={22} /></span>
          <ChevronRight size={26} />
          <span title="Classification"><BrainCircuit size={22} /></span>
          <ChevronRight size={26} />
          <span title="Extraction"><ScanText size={22} /></span>
          <ChevronRight size={26} />
          <span title="Validation"><ClipboardCheck size={22} /></span>
          <ChevronRight size={26} />
          <span title="Downstream"><Network size={22} /></span>
        </div>
        <div className="marketing-nav">
          <div className="marketing-brand">
            <img src="/icon-192.png" alt="" />
            <strong>Xtractor</strong>
          </div>
          <button type="button" className="marketing-secondary-link" onClick={() => { window.location.href = '/'; }}>
            Open app
          </button>
        </div>
        <div className="marketing-hero-content">
          <div className="marketing-copy">
            <span className="marketing-kicker">AI document intake for business teams</span>
            <h1>Turn document-heavy operations into validated structured data.</h1>
            <p>
              Xtractor classifies PDFs, extracts business fields, routes exceptions for human validation, and sends clean JSON to your downstream systems.
            </p>
            <div className="marketing-actions">
              <button type="button" className="marketing-primary-button" onClick={focusRequestForm}>
                Request a demo
                <ChevronRight size={18} />
              </button>
              <a className="marketing-text-link" href="#business-applications">Explore use cases</a>
            </div>
          </div>
          <div className="marketing-product-visual" aria-label="Xtractor workflow preview">
            <div className="visual-toolbar">
              <span>Processing queue</span>
              <strong>Live validation</strong>
            </div>
            <div className="visual-grid">
              <div className="visual-panel primary">
                <FileText size={24} />
                <strong>Invoice_0428.pdf</strong>
                <span>Classified as Accounts Payable</span>
              </div>
              <div className="visual-panel">
                <ShieldCheck size={22} />
                <strong>96%</strong>
                <span>Validation confidence</span>
              </div>
              <div className="visual-panel">
                <TrendingUp size={22} />
                <strong>JSON ready</strong>
                <span>ERP payload prepared</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="marketing-section" id="business-applications">
        <div className="marketing-section-heading">
          <span className="marketing-kicker">Business applications</span>
          <h2>Built for repeatable document operations.</h2>
        </div>
        <div className="marketing-card-grid">
          <article>
            <Building2 size={22} />
            <h3>Finance and AP</h3>
            <p>Capture invoice totals, vendor details, tax, due dates, and line items before sending clean data downstream.</p>
          </article>
          <article>
            <ClipboardCheck size={22} />
            <h3>Compliance review</h3>
            <p>Validate extracted fields side by side with the original PDF and preserve clear operational visibility.</p>
          </article>
          <article>
            <Sparkles size={22} />
            <h3>Template flexibility</h3>
            <p>Create extraction schemas for new document classes and reprocess files as business needs change.</p>
          </article>
        </div>
      </section>

      <section className="marketing-demo-band">
        <div>
          <span className="marketing-kicker">Request a walkthrough</span>
          <h2>See how Xtractor fits your intake workflow.</h2>
          <p>Share your email and optional phone number. Your request will be saved for the Xtract team to follow up.</p>
        </div>
        <form className="marketing-demo-form" id="demo-request-form" onSubmit={submitDemoRequest}>
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
        </form>
      </section>
    </main>
  );
}

function LoginScreen({ onLogin }: { onLogin: (username: string, password: string) => Promise<void> }) {
  const rememberedUsername = localStorage.getItem('xtract-remembered-username') || '';
  const [username, setUsername] = useState(rememberedUsername);
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(Boolean(rememberedUsername));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await onLogin(username, password);
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
          <p>Use your assigned username and password.</p>
        </div>
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
        {error && <div className="auth-error">{error}</div>}
        <button className="primary-button" type="submit" disabled={submitting || !username || !password}>
          {submitting ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
          Login
        </button>
      </form>
    </main>
  );
}

function PasswordResetScreen({ onNotify }: { onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

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

  return (
    <section className="panel narrow-panel">
      <div className="panel-heading">
        <div>
          <h2>Password Reset</h2>
          <p>Change your own password.</p>
        </div>
      </div>
      <form className="form-grid" onSubmit={submit}>
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
  const [resetTarget, setResetTarget] = useState<AuthUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AuthUser | null>(null);

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
    try {
      await api.createUser({ username: newUsername, password: newPassword, role: newRole });
      setNewUsername('');
      setNewPassword('');
      setNewRole('validator');
      onNotify('User created.', 'success');
      await loadUsers();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Failed to create user.', 'error');
    }
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
    const id = userId(resetTarget);
    if (!id) return;
    try {
      await api.resetUserPassword(id, resetPassword);
      setResetTarget(null);
      setResetPassword('');
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

  return (
    <div className="user-management">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>User Management</h2>
            <p>Add users, assign roles, and control access.</p>
          </div>
          <button className="icon-button" title="Refresh users" onClick={loadUsers}>
            {loadingUsers ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          </button>
        </div>
        <form className="user-create-form" onSubmit={createUser}>
          <label>
            Username
            <input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
          </label>
          <label>
            Initial password
            <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </label>
          <label>
            Role
            <select value={newRole} onChange={(event) => setNewRole(event.target.value as UserRole)}>
              <option value="validator">Validator</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <button className="primary-button" type="submit" disabled={!newUsername || !newPassword}>
            <Plus size={16} />
            Add user
          </button>
        </form>
      </section>
      <section className="panel">
        <div className="business-review-table">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const id = userId(user);
                const isSelf = id === currentUser.id;
                return (
                  <tr key={id || user.username}>
                    <td>{user.username}</td>
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
                    <td>{user.enabled ? 'Enabled' : 'Disabled'}</td>
                    <td>{user.createdAt ? new Date(user.createdAt).toLocaleString() : 'N/A'}</td>
                    <td>
                      <div className="table-actions">
                        <button className="secondary-button compact" type="button" onClick={() => {
                          setResetTarget(user);
                          setResetPassword('');
                        }}>
                          Reset password
                        </button>
                        <button
                          className="secondary-button compact"
                          type="button"
                          disabled={isSelf}
                          onClick={() => updateUser(user, { enabled: !user.enabled })}
                        >
                          {user.enabled ? 'Disable' : 'Enable'}
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
          {!users.length && <div className="empty-table">{loadingUsers ? 'Loading users.' : 'No users found.'}</div>}
        </div>
      </section>
      {resetTarget && (
        <ConfirmDialog
          title="Reset Password"
          body={
            <label>
              New password for {resetTarget.username}
              <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
            </label>
          }
          confirmLabel="Reset"
          confirmIcon={<KeyRound size={16} />}
          onCancel={() => setResetTarget(null)}
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

function DemoRequestsScreen({ onNotify }: { onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void }) {
  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(true);

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

  useEffect(() => {
    loadRequests();
  }, []);

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Demo Requests</h2>
          <p>Potential clients who requested a walkthrough from the Xtractor marketing site.</p>
        </div>
        <button className="icon-button" title="Refresh demo requests" onClick={loadRequests}>
          {loadingRequests ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
        </button>
      </div>
      <div className="business-review-table">
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
                <td>{request.email}</td>
                <td>{request.phone || 'N/A'}</td>
                <td>{request.source}</td>
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
    </section>
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
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Processing Summary</h2>
            <p>Persisted processing volume, token usage, and estimated OpenAI processing cost.</p>
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

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Recent Processed Files</h2>
            <p>Last five processed documents persisted by the business review.</p>
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
  const [expandedSections, setExpandedSections] = useState({
    aiService: true,
    documentProcessing: true,
    downstream: true,
  });

  function toggleSection(section: keyof typeof expandedSections) {
    setExpandedSections((current) => ({ ...current, [section]: !current[section] }));
  }

  async function refreshConfig() {
    await onRefresh();
  }

  async function saveConfig() {
    await onSave(config);
  }

  return (
    <div className="panel configuration-panel">
      <div className="configuration-form">
        <div className="configuration-section">
          <button
            className="configuration-section-toggle"
            type="button"
            aria-expanded={expandedSections.aiService}
            onClick={() => toggleSection('aiService')}
          >
            <span>AI Service Configuration</span>
            {expandedSections.aiService ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
          {expandedSections.aiService && (
            <div className="configuration-section-body">
              <label>
                AI provider
                <select
                  value={config.aiProvider}
                  onChange={(event) => onConfigChange({ ...config, aiProvider: event.target.value as AiProvider })}
                >
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama</option>
                </select>
              </label>
              {config.aiProvider === 'ollama' ? (
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
              ) : (
                <OpenAIModelControls
                  model={config.classificationModel || lowCostOpenAIModel}
                  reasoningEffort={config.classificationReasoningEffort || 'low'}
                  onModelChange={(classificationModel) => onConfigChange({ ...config, classificationModel })}
                  onReasoningEffortChange={(classificationReasoningEffort) => onConfigChange({ ...config, classificationReasoningEffort })}
                />
              )}
              <label>
                Embedding provider
                <select
                  value={config.embeddingProvider}
                  onChange={(event) => onConfigChange({ ...config, embeddingProvider: event.target.value as EmbeddingProvider })}
                >
                  <option value="openai">OpenAI</option>
                  <option value="ollama">Ollama</option>
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
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>

        <div className="configuration-section">
          <button
            className="configuration-section-toggle"
            type="button"
            aria-expanded={expandedSections.documentProcessing}
            onClick={() => toggleSection('documentProcessing')}
          >
            <span>Document Processing Configuration</span>
            {expandedSections.documentProcessing ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
          {expandedSections.documentProcessing && (
            <div className="configuration-section-body">
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
                <label>
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
                <label>
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
          )}
        </div>

        <div className="configuration-section">
          <button
            className="configuration-section-toggle"
            type="button"
            aria-expanded={expandedSections.downstream}
            onClick={() => toggleSection('downstream')}
          >
            <span>Downstream Configuration</span>
            {expandedSections.downstream ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
          {expandedSections.downstream && (
            <div className="configuration-section-body">
              <label>
                Downstream API URL
                <input
                  type="url"
                  placeholder="https://example.com/api/documents"
                  value={config.downstreamUrl}
                  onChange={(event) => onConfigChange({ ...config, downstreamUrl: event.target.value })}
                />
              </label>
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
              <p className="help-text">
                When saved, validation submits will forward clean JSON data to the downstream system using this URL.
              </p>
            </div>
          )}
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

  async function trainIncludedTypes() {
    await api.trainClassifier();
  }

  return (
    <div className="classification-layout">
      <section className="panel classification-summary">
        <StatusMetric label="Included Types" value={includedTypes.length} />
        <StatusMetric label="Trainable" value={trainableTypes.length} />
        <StatusMetric label="Trained" value={trainedCount} />
        <StatusMetric label="Sample Files" value={includedFileCount} />
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Classifier Training</h2>
            <p>Train classification for all document types marked for inclusion.</p>
            <div className="classifier-status-line">
              <span>Status</span>
              <strong className={`classifier-pill ${overallStatus}`}>{overallStatus}</strong>
            </div>
          </div>
          <div className="panel-heading-actions">
            <button
              className="secondary-button"
              onClick={() =>
                onRun(async () => {
                  await onSaveConfig(config);
                }, 'Classification model saved')
              }
            >
              <Save size={16} />
              Save Model
            </button>
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

        <div className="model-settings-band">
          <div>
            <strong>{aiModelLabel(config)}</strong>
            <small>LLM fallback for classification. Vectors use {embeddingModelLabel(config)}.</small>
          </div>
          {config.aiProvider === 'openai' ? (
            <OpenAIModelControls
              model={config.classificationModel || lowCostOpenAIModel}
              reasoningEffort={config.classificationReasoningEffort || 'low'}
              onModelChange={(classificationModel) => onConfigChange({ ...config, classificationModel })}
              onReasoningEffortChange={(classificationReasoningEffort) => onConfigChange({ ...config, classificationReasoningEffort })}
            />
          ) : (
            <div className="model-controls">
              <label>
                Model
                <input
                  value={config.ollamaModel}
                  onChange={(event) => onConfigChange({ ...config, ollamaModel: event.target.value })}
                />
              </label>
            </div>
          )}
        </div>

        <div className="classification-table">
          {includedTypes.map((type) => {
            const status = classifierStatus(type);
            return (
              <div className="classification-row" key={type._id}>
                <div>
                  <strong>{type.name}</strong>
                  <small>{type.category}</small>
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
    <div className="two-column">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Document Types</h2>
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
              <span>
                <strong>{type.name}</strong>
                <small>{type.category}</small>
              </span>
              <em>
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

      <section className="panel">
        {activeType ? (
          <>
            <div className="panel-heading">
              <div>
                <h2>{activeType.name}</h2>
                <p>{activeType.category}</p>
              </div>
              <button
                className="icon-button danger"
                title="Delete document type"
                onClick={() => setDeleteTypeTarget(activeType)}
              >
                <Trash2 size={17} />
              </button>
            </div>

            <div className={activeType.classifierTrainingStatus === 'trained' ? 'training-status ready' : 'training-status'}>
              <Gauge size={16} />
              <span>
                Classifier training: {activeType.classifierTrainingStatus || 'untrained'} with {activeType.sampleFiles.length} sample
                {activeType.sampleFiles.length === 1 ? '' : 's'}
              </span>
            </div>

            <div className="model-settings-band">
              <div>
                <strong>{config.aiProvider === 'ollama' ? `Ollama ${config.ollamaModel || defaultOllamaModel}` : modelLabel(activeType.extractionModel || lowCostOpenAIModel)}</strong>
                <small>Used for template generation and extraction for this document type.</small>
              </div>
              {config.aiProvider === 'openai' ? (
                <OpenAIModelControls
                  model={activeType.extractionModel || lowCostOpenAIModel}
                  reasoningEffort={activeType.extractionReasoningEffort || 'low'}
                  onModelChange={(extractionModel) =>
                    onRun(async () => {
                      const updated = await api.updateExtractionModel(activeType._id, {
                        extractionModel,
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
                      value={config.ollamaModel}
                      onChange={(event) => onConfigChange({ ...config, ollamaModel: event.target.value })}
                    />
                  </label>
                </div>
              )}
            </div>

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
              <div className="collapsible-section">
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
          </>
        ) : (
          <EmptyState text="Select a document type to view details." />
        )}
      </section>
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
  const trainedTypeCount = documentTypes.filter((type) => type.finalized && type.sampleFiles.length > 0).length;

  useEffect(() => {
    setCategory((current) => current || categories[0] || '');
  }, [categories]);

  useEffect(() => {
    const first = documentTypes.find((type) => type.category === category);
    setDocumentTypeId(first?._id ?? '');
  }, [category, documentTypes.length]);

  return (
    <section className="panel upload-panel">
      <div className="panel-heading">
        <div>
          <h2>Upload Documents</h2>
          <p>Send new files into the extraction workflow.</p>
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
        <label className="span-2 checkbox-row">
          <input
            type="checkbox"
            checked={autoClassify}
            onChange={(event) => setAutoClassify(event.target.checked)}
          />
          <span>
            Auto classify with trained samples
            <small>{trainedTypeCount} trained document type{trainedTypeCount === 1 ? '' : 's'} available</small>
          </span>
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
        <label className="file-drop span-2">
          <Upload size={28} />
          <span>
            {files.length > 0
              ? `${files.length} PDF${files.length === 1 ? '' : 's'} selected`
              : 'Choose PDFs for extraction'}
          </span>
          <input
            type="file"
            accept="application/pdf"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
        </label>
        <button
          className="primary-button"
          disabled={(!autoClassify && !documentTypeId) || (autoClassify && trainedTypeCount === 0) || files.length === 0}
        >
          <Upload size={16} />
          {autoClassify ? 'Classify & Process' : `Upload Document${files.length === 1 ? '' : 's'}`}
        </button>
      </form>
    </section>
  );
}

function DocumentList({
  documents,
  documentTypes,
  pagination,
  statusTarget,
  config,
  canManage = false,
  onOpen,
  onPage,
}: {
  documents: IncomingDocument[];
  documentTypes: DocumentType[];
  pagination: PagedResult<IncomingDocument>;
  statusTarget: { status: DocumentStatusFilter; version: number };
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
  }, [statusTarget.version]);

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
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Documents</h2>
          <p>Browse uploaded files and manage document state.</p>
        </div>
        <div className="panel-heading-actions">
          <button className="icon-button" title="Refresh document list" onClick={() => loadPage(pagination.page)}>
            <RefreshCw size={16} />
          </button>
        </div>
      </div>
      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as DocumentStatusFilter)}>
            <option value="">All</option>
            <option value="processing">Processing</option>
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

      <div className="document-table">
        {documents.map((doc) => (
          <div className="document-row" key={doc._id}>
            <button className="document-open" onClick={() => onOpen(doc._id)}>
              <span>
                <strong>{doc.originalName}</strong>
                <small>
                  {doc.category} / {doc.documentTypeName}
                </small>
                <small>
                  Classification: {displayModel(doc.classificationModel)} | Extraction: {displayModel(doc.processingMetrics?.model)}
                </small>
              </span>
              <span className={`pill ${doc.status}`}>{doc.status}</span>
              <span className={`score-badge${scoreToneClass(doc.classificationScore)}`}>
                {formatScore(doc.classificationScore)}
                <ClassificationMethodIcon
                  method={doc.classificationMethod}
                  onShowJustification={doc.classificationMethod === 'llm' ? () => setJustificationTarget(doc) : undefined}
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
                  className="icon-button"
                  title="Reclassify document"
                  onClick={(event) => {
                    event.stopPropagation();
                    setReclassifyTarget(doc);
                    const docCategory = doc.category;
                    setReclassifyCategory(docCategory);
                    setReclassifyDocumentType(doc.documentTypeId || '');
                  }}
                >
                  <BrainCircuit size={16} />
                </button>
                <button
                  className="icon-button"
                  title="Reprocess document"
                  onClick={(event) => {
                    event.stopPropagation();
                    setReprocessTarget(doc);
                  }}
                >
                  <RotateCcw size={16} />
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
          body={`Delete "${deleteTarget.originalName}" and its uploaded PDF file?`}
          confirmLabel="Delete"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteDocument(deleteTarget)}
        />
      )}

      {justificationTarget && (
        <ClassificationJustificationDialog document={justificationTarget} onClose={() => setJustificationTarget(null)} />
      )}

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
  isDanger = true,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string | JSX.Element;
  confirmLabel: string;
  confirmIcon?: JSX.Element;
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
            <p>{body}</p>
          </div>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <X size={17} />
          </button>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button className={`primary-button${isDanger ? ' danger-action' : ''}`} onClick={onConfirm}>
            {confirmIcon || <Trash2 size={16} />}
            {confirmLabel}
          </button>
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
              {openAIModelOptions.map((option) => (
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
      extractedData: normalizedValues,
      exportedAt: new Date().toISOString(),
    });
    onNotify('JSON downloaded', 'success');
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
              <p>{document.category} / {document.documentTypeName}</p>
              <div className="classification-score-line">
                <span>Classification score</span>
                <strong className={scoreToneClass(document.classificationScore).trim() || undefined}>
                  {formatScore(document.classificationScore)}
                </strong>
                <ClassificationMethodIcon
                  method={document.classificationMethod}
                  onShowJustification={document.classificationMethod === 'llm' ? () => setShowClassificationJustification(true) : undefined}
                />
              </div>
              <div className="document-model-line">
                <span>Classification: {displayModel(document.classificationModel)}</span>
                <span>Extraction: {displayModel(document.processingMetrics?.model)}</span>
              </div>
            </div>
            <div className="panel-heading-actions">
              <div className="validation-header-badges">
                <span className={`pill ${document.status}`}>{document.status}</span>
                <span className="processing-mode-badge">
                  <ProcessingModeIcon mode={document.processingMode} />
                  {document.processingMode ? document.processingMode.toUpperCase() : 'N/A'}
                </span>
              </div>
              <button className="icon-button validation-refresh-button" title="Refresh validation page" onClick={refreshPage}>
                <RefreshCw size={16} />
              </button>
              <button className="icon-button" title="Download extracted data as JSON" onClick={downloadExtractedJson}>
                <Download size={16} />
              </button>
            </div>
          </div>
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
        {!isLocked && (
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
                    className="icon-button"
                    type="button"
                    title="Reclassify document"
                    aria-label="Reclassify document"
                    onClick={() => setShowReclassifyDialog(true)}
                  >
                    <BrainCircuit size={16} />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="Reprocess document"
                    aria-label="Reprocess document"
                    onClick={() => setShowReprocessDialog(true)}
                  >
                    <RotateCcw size={16} />
                  </button>
                </>
              )}
              <button className="secondary-button danger-outline" type="button" onClick={() => setPendingValidationAction('reject')}>
                <X size={16} />
                Reject
              </button>
              <button className="primary-button" type="button" onClick={() => setPendingValidationAction('validate')}>
                <CheckCircle2 size={16} />
                Validate
              </button>
            </div>
          </div>
        )}
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
