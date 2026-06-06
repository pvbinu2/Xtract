import { ChangeEvent, FormEvent, useEffect, useMemo, useState, useRef } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  CheckCircle2,
  BarChart3,
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
} from 'lucide-react';
import { api, AppConfigPayload } from './api';
import { BusinessReviewSummary, DocumentType, ExtractedValue, ExtractionField, FieldType, IncomingDocument, PagedResult, ReasoningEffort, TableColumn } from './types';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();

type View = 'types' | 'classification' | 'upload' | 'documents' | 'validation' | 'configuration' | 'business-review';

type AppConfig = AppConfigPayload;
type OperationsMetrics = {
  filesProcessed: number;
  totalCostUsd: number;
  filesProcessing: number;
  filesReady: number;
};

const fieldTypes: FieldType[] = ['string', 'number', 'date', 'currency', 'boolean', 'table'];
const lowCostOpenAIModel = 'gpt-5-nano';
const openAIModelOptions = [
  { value: 'gpt-5-nano', label: 'GPT-5 Nano' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'gpt-4o', label: 'GPT-4o' },
];
const reasoningEffortOptions: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const displayCurrencyOptions = [
  { value: 'USD', label: 'US dollar', rate: 1 },
  { value: 'INR', label: 'Indian rupee', rate: 83.5 },
  { value: 'GBP', label: 'British pound', rate: 0.79 },
  { value: 'EUR', label: 'Euro', rate: 0.92 },
] as const;
type DisplayCurrency = (typeof displayCurrencyOptions)[number]['value'];

function supportsReasoningEffort(model: string) {
  return /^(gpt-5|o\d|o\d-)/.test(model);
}

function modelLabel(model?: string) {
  return openAIModelOptions.find((option) => option.value === model)?.label || model || 'OpenAI model';
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

function displaySampleName(fileName: string) {
  const parts = fileName.split('/');
  return parts[parts.length - 1] || fileName;
}

function ClassificationMethodIcon({ method }: { method?: IncomingDocument['classificationMethod'] }) {
  if (method === 'vector') {
    return (
      <span className="method-icon vector" title="Vector classification" aria-label="Vector classification">
        <Network size={14} />
      </span>
    );
  }
  if (method === 'llm') {
    return (
      <span className="method-icon llm" title="LLM classification" aria-label="LLM classification">
        <BrainCircuit size={14} />
      </span>
    );
  }
  return null;
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

export function App() {
  const [view, setView] = useState<View>('documents');
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  const [documents, setDocuments] = useState<IncomingDocument[]>([]);
  const [documentPage, setDocumentPage] = useState<PagedResult<IncomingDocument>>({
    items: [],
    total: 0,
    page: 1,
    pageSize: 10,
    totalPages: 1,
  });
  const [activeTypeId, setActiveTypeId] = useState('');
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [loading, setLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
    classificationModel: lowCostOpenAIModel,
    classificationReasoningEffort: 'low',
  });

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
            classificationModel: parsed.classificationModel || lowCostOpenAIModel,
            classificationReasoningEffort: parsed.classificationReasoningEffort || 'low',
          });
        } catch {
          // ignore invalid saved config
        }
      }
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
  }

  async function refreshDocuments() {
    const docs = await api.listDocuments(
      new URLSearchParams({
        sort: 'latest',
        page: String(documentPage.page),
        pageSize: String(documentPage.pageSize),
      }),
    );
    setDocumentPage(docs);
    setDocuments(docs.items);
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
    return docs;
  }

  function showToast(text: string, type: 'success' | 'error' | 'info' = 'info') {
    setToast({ text, type });
  }

  async function refresh() {
    await Promise.all([refreshDocumentTypes(), refreshDocuments(), refreshOperationsMetrics()]);
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
    if (!currentId) return;

    const currentIndex = documents.findIndex((item) => item._id === currentId);
    if (direction === 'previous') {
      if (currentIndex > 0) {
        setActiveDocumentId(documents[currentIndex - 1]._id);
        setView('validation');
        return;
      }

      if (currentIndex === 0 && documentPage.page > 1) {
        const previousPage = await loadDocumentsPage(documentPage.page - 1);
        const previousDocument = previousPage.items.at(-1);
        if (previousDocument) {
          setActiveDocumentId(previousDocument._id);
          setView('validation');
        }
      }
      return;
    }

    if (currentIndex >= 0 && currentIndex < documents.length - 1) {
      setActiveDocumentId(documents[currentIndex + 1]._id);
      setView('validation');
      return;
    }

    if (currentIndex === documents.length - 1 && documentPage.page < documentPage.totalPages) {
      const nextPage = await loadDocumentsPage(documentPage.page + 1);
      const nextDocument = nextPage.items[0];
      if (nextDocument) {
        setActiveDocumentId(nextDocument._id);
        setView('validation');
      }
    }
  }

  useEffect(() => {
    refresh().catch((error) => showToast(error.message, 'error'));
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('xtract-dark-mode');
    setDarkMode(stored === 'true');
    setSidebarCollapsed(localStorage.getItem('xtract-sidebar-collapsed') === 'true');
    loadConfiguration().catch(() => {
      // fallback to local storage if remote config is unavailable
    });
  }, []);

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

  const navigation = [
    { id: 'documents' as View, label: 'Documents', icon: Files },
    { id: 'upload' as View, label: 'Upload', icon: FilePlus2 },
    { id: 'types' as View, label: 'Document Types', icon: ClipboardCheck },
    { id: 'classification' as View, label: 'Classification', icon: BrainCircuit },
    { id: 'configuration' as View, label: 'Configuration', icon: Gauge },
    { id: 'business-review' as View, label: 'Business Review', icon: BarChart3 },
  ];
  const validationDocumentId = activeDocumentId || documents[0]?._id || '';
  const validationDocumentIndex = documents.findIndex((item) => item._id === validationDocumentId);
  const canNavigatePreviousDocument =
    Boolean(validationDocumentId) &&
    (documentPage.page > 1 || validationDocumentIndex > 0);
  const canNavigateNextDocument =
    Boolean(validationDocumentId) &&
    (documentPage.page < documentPage.totalPages ||
      (validationDocumentIndex >= 0 && validationDocumentIndex < documents.length - 1));

  return (
    <main className={sidebarCollapsed ? 'app-shell sidebar-collapsed' : 'app-shell'}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">X</div>
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
            {sidebarCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </button>
        </div>
        <nav>
          {navigation.map((item) => {
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
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Extraction operations</p>
            <h1>{view === 'validation' ? 'Validation' : navigation.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <div className="status-strip">
              <StatusMetric label="Files processed" value={operationsMetrics.filesProcessed} />
              <StatusMetric label="Total cost" value={formatCurrency(operationsMetrics.totalCostUsd)} />
              <StatusMetric label="Processing" value={operationsMetrics.filesProcessing} />
              <StatusMetric label="Ready" value={operationsMetrics.filesReady} />
            </div>
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

        {view === 'types' && (
          <DocumentTypeManagement
            documentTypes={documentTypes}
            activeType={activeType}
            setActiveTypeId={setActiveTypeId}
            categories={categories}
            onRun={run}
            onRefresh={refreshDocumentTypes}
          />
        )}
        {view === 'classification' && (
          <ClassificationScreen
            documentTypes={documentTypes}
            config={config}
            onConfigChange={setConfig}
            onSaveConfig={saveConfiguration}
            onRun={run}
            onRefresh={refreshDocumentTypes}
          />
        )}
        {view === 'upload' && (
          <UploadScreen
            categories={categories}
            documentTypes={documentTypes}
            onRun={run}
            onRefresh={refreshDocumentTypes}
            openDocuments={() => setView('documents')}
          />
        )}
        {view === 'documents' && (
          <DocumentList
            documents={documents}
            documentTypes={documentTypes}
            pagination={documentPage}
            onOpen={(id) => {
              setActiveDocumentId(id);
              setView('validation');
            }}
            onPage={(page) => {
              setDocumentPage(page);
              setDocuments(page.items);
            }}
          />
        )}
        {view === 'business-review' && (
          <BusinessReviewScreen onNotify={showToast} />
        )}
        {view === 'validation' && (
          <ValidationScreen
            documentId={validationDocumentId}
            documentTypes={documentTypes}
            downstreamUrl={config.downstreamUrl}
            defaultDeleteAfterDownstream={config.deleteAfterDownstream}
            sendKeyValuePairs={config.sendKeyValuePairs}
            canNavigatePrevious={canNavigatePreviousDocument}
            canNavigateNext={canNavigateNextDocument}
            onNavigatePrevious={() => moveToAdjacentDocument(validationDocumentId, 'previous')}
            onNavigateNext={() => moveToAdjacentDocument(validationDocumentId, 'next')}
            onRefresh={refreshDocumentTypes}
            onValidated={async (_notification: string) => {
              await moveToNextDocument(validationDocumentId);
            }}
            onNotify={showToast}
          />
        )}
        {view === 'configuration' && (
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

function StatusMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
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

function BusinessReviewScreen({ onNotify }: { onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void }) {
  const [summary, setSummary] = useState<BusinessReviewSummary | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [displayCurrency, setDisplayCurrency] = useState<DisplayCurrency>('USD');

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
              <select value={displayCurrency} onChange={(event) => setDisplayCurrency(event.target.value as DisplayCurrency)}>
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
          <ReviewMetric label="Files processed" value={formatNumber(summary.filesProcessed)} helper={`${formatNumber(summary.totalFiles)} total files`} />
          <ReviewMetric label="Estimated cost" value={formatReviewCurrency(summary.estimatedCostUsd)} helper="Extraction + classification + embeddings" />
          <ReviewMetric label="Avg cost / document" value={formatReviewCurrency(averageCostPerDocument)} helper={`${formatNumber(summary.filesProcessed)} processed files`} />
          <ReviewMetric label="Total tokens" value={formatNumber(summary.tokens.total)} helper={`${formatNumber(summary.filesProcessed)} persisted processing events`} />
          <ReviewMetric label="Input tokens" value={formatNumber(summary.tokens.input)} />
          <ReviewMetric label="Output tokens" value={formatNumber(summary.tokens.output)} />
        </div>
        <p className="help-text">
          Summary totals are consolidated when processing completes and are stored separately from document records.
        </p>
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
                <tr key={document.id}>
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
            <strong>{modelLabel(config.classificationModel)}</strong>
            <small>Used when vector classification falls back to OpenAI.</small>
          </div>
          <OpenAIModelControls
            model={config.classificationModel || lowCostOpenAIModel}
            reasoningEffort={config.classificationReasoningEffort || 'low'}
            onModelChange={(classificationModel) => onConfigChange({ ...config, classificationModel })}
            onReasoningEffortChange={(classificationReasoningEffort) => onConfigChange({ ...config, classificationReasoningEffort })}
          />
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
  setActiveTypeId,
  categories,
  onRun,
  onRefresh,
}: {
  documentTypes: DocumentType[];
  activeType?: DocumentType;
  setActiveTypeId: (id: string) => void;
  categories: string[];
  onRun: (action: () => Promise<void>, success: string) => Promise<void>;
  onRefresh: () => Promise<void>;
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
                <strong>{modelLabel(activeType.extractionModel || lowCostOpenAIModel)}</strong>
                <small>Used for template generation and extraction for this document type.</small>
              </div>
              <OpenAIModelControls
                model={activeType.extractionModel || lowCostOpenAIModel}
                reasoningEffort={activeType.extractionReasoningEffort || 'low'}
                onModelChange={(extractionModel) =>
                  onRun(async () => {
                    await api.updateExtractionModel(activeType._id, {
                      extractionModel,
                      extractionReasoningEffort: activeType.extractionReasoningEffort || 'low',
                    });
                    await onRefresh();
                  }, 'Extraction model saved')
                }
                onReasoningEffortChange={(extractionReasoningEffort) =>
                  onRun(async () => {
                    await api.updateExtractionModel(activeType._id, {
                      extractionModel: activeType.extractionModel || lowCostOpenAIModel,
                      extractionReasoningEffort,
                    });
                    await onRefresh();
                  }, 'Extraction reasoning effort saved')
                }
              />
            </div>

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
  onOpen,
  onPage,
}: {
  documents: IncomingDocument[];
  documentTypes: DocumentType[];
  pagination: PagedResult<IncomingDocument>;
  onOpen: (id: string) => void;
  onPage: (page: PagedResult<IncomingDocument>) => void;
}) {
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [nameFilter, setNameFilter] = useState('');
  const [sort, setSort] = useState('latest');
  const [pageSize, setPageSize] = useState(10);
  const [deleteTarget, setDeleteTarget] = useState<IncomingDocument | null>(null);
  const [reprocessTarget, setReprocessTarget] = useState<IncomingDocument | null>(null);
  const [reclassifyTarget, setReclassifyTarget] = useState<IncomingDocument | null>(null);
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

  async function deleteDocument(document: IncomingDocument) {
    await api.deleteDocument(document._id);
    setDeleteTarget(null);
    const nextPage = documents.length === 1 && pagination.page > 1 ? pagination.page - 1 : pagination.page;
    await loadPage(nextPage);
  }

  async function reprocessDocument(document: IncomingDocument) {
    await api.reprocessDocument(document._id);
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
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
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
              <span className="score-badge">
                {formatScore(doc.classificationScore)}
                <ClassificationMethodIcon method={doc.classificationMethod} />
              </span>
              <span className="processing-mode-badge">
                <ProcessingModeIcon mode={doc.processingMode} />
                {doc.processingMode ? doc.processingMode.toUpperCase() : 'N/A'}
              </span>
              <time>{new Date(doc.createdAt).toLocaleString()}</time>
            </button>
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

      {reprocessTarget && (
        <ConfirmDialog
          title="Reprocess Document"
          body={`Reprocess "${reprocessTarget.originalName}"? This will re-run the extraction on this document.`}
          confirmLabel="Reprocess"
          onCancel={() => setReprocessTarget(null)}
          onConfirm={() => {
            reprocessDocument(reprocessTarget);
            setReprocessTarget(null);
          }}
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

function ValidationScreen({
  documentId,
  documentTypes,
  downstreamUrl,
  defaultDeleteAfterDownstream = false,
  sendKeyValuePairs = false,
  canNavigatePrevious = false,
  canNavigateNext = false,
  onNavigatePrevious,
  onNavigateNext,
  onRefresh,
  onValidated,
  onNotify,
}: {
  documentId: string;
  documentTypes: DocumentType[];
  downstreamUrl: string;
  defaultDeleteAfterDownstream?: boolean;
  sendKeyValuePairs?: boolean;
  canNavigatePrevious?: boolean;
  canNavigateNext?: boolean;
  onNavigatePrevious: () => Promise<void>;
  onNavigateNext: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onValidated: (notification: string) => Promise<void>;
  onNotify: (notification: string, type?: 'success' | 'error' | 'info') => void;
}) {
  const [document, setDocument] = useState<IncomingDocument | null>(null);
  const [values, setValues] = useState<ExtractedValue[]>([]);
  const [tableEditIndex, setTableEditIndex] = useState<number | null>(null);
  const [editingValueKey, setEditingValueKey] = useState<string | null>(null);
  const [editingValueDraft, setEditingValueDraft] = useState('');
  const [savingValueKey, setSavingValueKey] = useState<string | null>(null);
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null);
  const [showReclassifyDialog, setShowReclassifyDialog] = useState(false);
  const [reclassifyCategory, setReclassifyCategory] = useState('');
  const [reclassifyDocumentType, setReclassifyDocumentType] = useState('');
  const [deleteAfterDownstream, setDeleteAfterDownstream] = useState(defaultDeleteAfterDownstream);
  const [pendingValidationAction, setPendingValidationAction] = useState<'validate' | 'reject' | null>(null);
  const documentTypeFor = (doc: IncomingDocument) => documentTypes.find((type) => type._id === doc.documentTypeId);

  async function refreshPage() {
    if (!documentId) return;
    const refreshed = await api.getDocument(documentId);
    const normalizedValues = normalizeExtractedDataToSchema(refreshed.extractedData, documentTypeFor(refreshed));
    setDocument({ ...refreshed, extractedData: normalizedValues });
    setValues(normalizedValues);
    setReclassifyCategory(refreshed.category);
    setReclassifyDocumentType(refreshed.documentTypeId || '');
    await onRefresh();
    onNotify('Validation page refreshed');
  }

  useEffect(() => {
    setDeleteAfterDownstream(defaultDeleteAfterDownstream);
  }, [defaultDeleteAfterDownstream]);

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
    api.getDocument(documentId).then((doc) => {
      const normalizedValues = normalizeExtractedDataToSchema(doc.extractedData, documentTypeFor(doc));
      setDocument({ ...doc, extractedData: normalizedValues });
      setValues(normalizedValues);
      setEditingValueKey(null);
      setEditingValueDraft('');
      setSavingValueKey(null);
      setReclassifyCategory(doc.category);
      setReclassifyDocumentType(doc.documentTypeId || '');
    });
  }, [documentId, documentTypes]);

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
    await api.validateDocument(document._id, normalized, deleteAfterDownstream, downstreamUrl, sendKeyValuePairs);
    const message = `Document validated: ${document.originalName}`;
    onNotify(message, 'success');
    await onValidated(message);
  }

  async function reject() {
    if (!document) return;
    setPendingValidationAction(null);
    await api.rejectDocument(document._id, deleteAfterDownstream, downstreamUrl, sendKeyValuePairs);
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

  async function reprocess() {
    if (!document) return;
    const updated = await api.reprocessDocument(document._id);
    const message = `Document reprocessing started: ${document.originalName}`;
    const normalizedValues = normalizeExtractedDataToSchema(updated.extractedData, documentTypeFor(updated));
    setDocument({ ...updated, extractedData: normalizedValues });
    setValues(normalizedValues);
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
          url={api.documentFileUrl(document._id)}
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
                <strong>{formatScore(document.classificationScore)}</strong>
                <ClassificationMethodIcon method={document.classificationMethod} />
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
          {!downstreamUrl && (
            <div className="toast inline">
              Downstream URL is not configured. Document validation will complete locally only.
            </div>
          )}
          <div className="extraction-form">
            {values.map((item, index) => {
              const styles = fieldStyles[item.key];
              const isActive = item.key === activeFieldKey;
              const wrapperStyle = {
                borderColor: styles?.border,
                backgroundColor: isActive ? styles?.activeFill : styles?.fill,
              } as const;

              const isEditingValue = editingValueKey === item.key;
              const isSavingValue = savingValueKey === item.key;

              return item.type === 'table' ? (
                <div
                  className={`extraction-field${isActive ? ' active' : ''}`}
                  key={item.key}
                  style={wrapperStyle}
                >
                  <div className="field-label">
                    <button className="value-link" onClick={() => setActiveFieldKey(item.key)}>
                      {item.label}
                    </button>
                    {item.confidence && <em>{Math.round(item.confidence * 100)}%</em>}
                  </div>
                  <TableValuePreview item={item} canEdit={!isLocked} onEdit={() => setTableEditIndex(index)} />
                </div>
              ) : (
                <div
                  key={item.key}
                  className={`extraction-field${isActive ? ' active' : ''}`}
                  style={wrapperStyle}
                >
                  <div className="field-label">
                    <button className="value-link" type="button" onClick={() => setActiveFieldKey(item.key)}>
                      {item.label}
                    </button>
                    {item.confidence && <em>{Math.round(item.confidence * 100)}%</em>}
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
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={deleteAfterDownstream}
                onChange={(event) => setDeleteAfterDownstream(event.target.checked)}
              />
              <span>Delete document after sending to downstream</span>
            </label>
            <div className="validation-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={!canNavigatePrevious}
                onClick={onNavigatePrevious}
              >
                <ChevronLeft size={16} />
                Previous
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={!canNavigateNext}
                onClick={onNavigateNext}
              >
                Next
                <ChevronRight size={16} />
              </button>
              <button className="secondary-button" type="button" onClick={() => setShowReclassifyDialog(true)}>
                <BrainCircuit size={16} />
                Reclassify
              </button>
              <button className="secondary-button" type="button" onClick={reprocess}>
                <RotateCcw size={16} />
                Reprocess
              </button>
              <button className="secondary-button danger-outline" type="button" onClick={() => setPendingValidationAction('reject')}>
                <X size={16} />
                Reject
              </button>
              <button className="primary-button" type="button" onClick={() => setPendingValidationAction('validate')}>
                <CheckCircle2 size={16} />
                Submit Validation
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
  url,
  highlights,
  activeFieldKey,
}: {
  url: string;
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
  const [pages, setPages] = useState<Array<{ dataUrl: string; width: number; height: number }>>([]);
  const pdfContainerRef = useRef<HTMLDivElement>(null);

  function centerHighlightInPdfPane(highlightElement: HTMLElement) {
    const pdfPane = pdfContainerRef.current?.closest('.pdf-pane') as HTMLElement | null;
    if (!pdfPane) {
      highlightElement.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      return;
    }

    const paneRect = pdfPane.getBoundingClientRect();
    const highlightRect = highlightElement.getBoundingClientRect();
    const scrollTop =
      pdfPane.scrollTop + highlightRect.top - paneRect.top - pdfPane.clientHeight / 2 + highlightRect.height / 2;
    const scrollLeft =
      pdfPane.scrollLeft + highlightRect.left - paneRect.left - pdfPane.clientWidth / 2 + highlightRect.width / 2;

    pdfPane.scrollTo({
      top: Math.max(0, scrollTop),
      left: Math.max(0, scrollLeft),
      behavior: 'smooth',
    });
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pdf = await getDocument(url).promise;
      const rendered: Array<{ dataUrl: string; width: number; height: number }> = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        if (!context) continue;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;
        rendered.push({ dataUrl: canvas.toDataURL('image/png'), width: viewport.width, height: viewport.height });
      }
      if (!cancelled) setPages(rendered);
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!pdfContainerRef.current) return;
    const selectedHighlights = highlights.filter((box) => box.fieldKey === activeFieldKey);
    if (selectedHighlights.length === 0) return;

    const firstHighlight = selectedHighlights[0];
    const targetPageIndex = firstHighlight.page;

    const pageElements = pdfContainerRef.current.querySelectorAll('.pdf-page');
    if (targetPageIndex >= 0 && targetPageIndex < pageElements.length) {
      const targetPageElement = pageElements[targetPageIndex];
      const activeHighlights = targetPageElement.querySelectorAll('.pdf-highlight.active');
      const activeHighlight = activeHighlights[0] as HTMLElement | undefined;

      if (activeHighlight) {
        centerHighlightInPdfPane(activeHighlight);
      } else {
        targetPageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }

      setTimeout(() => {
        if (activeHighlight) {
          activeHighlight.focus({ preventScroll: true });
        }
      }, 100);
    }
  }, [highlights, activeFieldKey]);

  return (
    <div className="pdf-pages" ref={pdfContainerRef}>
      {pages.map((page, index) => (
        <div className="pdf-page" key={index} style={{ aspectRatio: `${page.width} / ${page.height}` }}>
          <img alt={`PDF page ${index + 1}`} src={page.dataUrl} />
          {highlights
            .filter((box) => box.page === index)
            .map((box, boxIndex) => {
              const isActive = box.fieldKey === activeFieldKey;
              return (
                <div
                  className={`pdf-highlight${isActive ? ' active' : ''}`}
                  key={`${index}-${boxIndex}`}
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
      ))}
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
