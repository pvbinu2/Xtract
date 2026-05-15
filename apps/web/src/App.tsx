import { ChangeEvent, FormEvent, useEffect, useMemo, useState, useRef } from 'react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ClipboardCheck,
  Moon,
  PlusCircle,
  FilePlus2,
  FileSearch,
  Files,
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
} from 'lucide-react';
import { api } from './api';
import { DocumentType, ExtractedValue, ExtractionField, FieldType, IncomingDocument, PagedResult } from './types';

GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).toString();

type View = 'types' | 'upload' | 'documents' | 'validation';

const fieldTypes: FieldType[] = ['string', 'number', 'date', 'currency', 'boolean', 'table'];

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

export function App() {
  const [view, setView] = useState<View>('types');
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
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  const activeType = activeTypeId ? documentTypes.find((item) => item._id === activeTypeId) : undefined;
  const categories = useMemo(
    () => Array.from(new Set(documentTypes.map((item) => item.category))).sort(),
    [documentTypes],
  );

  async function refresh() {
    const [types, docs] = await Promise.all([
      api.listDocumentTypes(),
      api.listDocuments(new URLSearchParams({ sort: 'latest', page: '1', pageSize: '10' })),
    ]);
    setDocumentTypes(types);
    setDocumentPage(docs);
    setDocuments(docs.items);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem('xtract-dark-mode');
    setDarkMode(stored === 'true');
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light';
    localStorage.setItem('xtract-dark-mode', String(darkMode));
  }, [darkMode]);

  async function run(action: () => Promise<void>, success: string) {
    setLoading(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  const navigation = [
    { id: 'types' as View, label: 'Document Types', icon: ClipboardCheck },
    { id: 'upload' as View, label: 'Upload', icon: FilePlus2 },
    { id: 'documents' as View, label: 'Documents', icon: Files },
  ];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">X</div>
          <div>
            <strong>Xtract</strong>
            <span>Document intake</span>
          </div>
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
        <button className="ghost-button" onClick={() => refresh()} title="Refresh">
          <RefreshCw size={16} />
          Refresh
        </button>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Extraction operations</p>
            <h1>{view === 'validation' ? 'Validation' : navigation.find((item) => item.id === view)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <div className="status-strip">
              <StatusMetric label="Processing" value={documents.filter((doc) => doc.status === 'processing').length} />
              <StatusMetric label="Ready" value={documents.filter((doc) => doc.status === 'extracted').length} />
              <StatusMetric label="Validated" value={documents.filter((doc) => doc.status === 'validated').length} />
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

        {message && <div className="toast">{message}</div>}
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
            onRefresh={refresh}
          />
        )}
        {view === 'upload' && (
          <UploadScreen
            categories={categories}
            documentTypes={documentTypes}
            onRun={run}
            onRefresh={refresh}
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
        {view === 'validation' && (
          <ValidationScreen
            documentId={activeDocumentId || documents[0]?._id || ''}
            onValidated={async () => {
              await refresh();
              setView('documents');
            }}
          />
        )}
      </section>
    </main>
  );
}

function StatusMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
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
  const [showCreateModal, setShowCreateModal] = useState(false);

  useEffect(() => {
    setFields(withUiIds(activeType?.fields ?? []));
    setPrompt(activeType?.prompt || prompt);
    setSchemaEditing(false);
    setExpandedTables({});
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
          <h2>Document Types</h2>
          <button className="icon-button" title="Create document type" onClick={() => setShowCreateModal(true)}>
            <Plus size={18} />
          </button>
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
              <em>{type.finalized ? 'Saved' : 'Draft'}</em>
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
                onClick={() =>
                  onRun(async () => {
                    await api.deleteDocumentType(activeType._id);
                    await onRefresh();
                  }, 'Document type deleted')
                }
              >
                <Trash2 size={17} />
              </button>
            </div>

            {!fields.length && (
              <>
                <div className="sample-row">
                  <input type="file" accept="application/pdf" onChange={(event) => setSample(event.target.files?.[0] ?? null)} />
                  <button
                    className="secondary-button"
                    disabled={!sample}
                    onClick={() =>
                      sample &&
                      onRun(async () => {
                        await api.uploadSample(activeType._id, sample);
                        await onRefresh();
                      }, 'Sample uploaded')
                    }
                  >
                    <Upload size={16} />
                    Sample
                  </button>
                </div>

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
              <div className="schema-toolbar">
                <h3>Extraction Schema</h3>
                {!schemaEditing ? (
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
                )}
              </div>
            )}

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
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    setCategory((current) => current || categories[0] || '');
  }, [categories]);

  useEffect(() => {
    const first = documentTypes.find((type) => type.category === category);
    setDocumentTypeId(first?._id ?? '');
  }, [category, documentTypes.length]);

  return (
    <section className="panel upload-panel">
      <form
        className="form-grid"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!files.length) return;
          onRun(async () => {
            await api.uploadDocuments({ category, documentTypeId, files });
            await onRefresh();
            openDocuments();
          }, 'Documents uploaded and processed');
        }}
      >
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
        <button className="primary-button" disabled={!documentTypeId || files.length === 0}>
          <Upload size={16} />
          Upload Document{files.length === 1 ? '' : 's'}
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
  const [sort, setSort] = useState('latest');
  const [pageSize, setPageSize] = useState(10);
  const [deleteTarget, setDeleteTarget] = useState<IncomingDocument | null>(null);
  const [reprocessTarget, setReprocessTarget] = useState<IncomingDocument | null>(null);
  const categories = Array.from(new Set(documentTypes.map((type) => type.category))).sort();

  async function loadPage(page: number) {
    const params = new URLSearchParams({
      sort,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (status) params.set('status', status);
    if (category) params.set('category', category);
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

  return (
    <section className="panel">
      <div className="filters">
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All</option>
            <option value="processing">Processing</option>
            <option value="extracted">Extracted</option>
            <option value="validated">Validated</option>
            <option value="failed">Failed</option>
          </select>
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
        <button className="secondary-button" onClick={applyFilters}>
          <ChevronDown size={16} />
          Apply
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
              </span>
              <span className={`pill ${doc.status}`}>{doc.status}</span>
              <time>{new Date(doc.createdAt).toLocaleString()}</time>
            </button>
            <div className="row-actions">
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
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
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
          <button className="primary-button danger-action" onClick={onConfirm}>
            <Trash2 size={16} />
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function ValidationScreen({ documentId, onValidated }: { documentId: string; onValidated: () => Promise<void> }) {
  const [document, setDocument] = useState<IncomingDocument | null>(null);
  const [values, setValues] = useState<ExtractedValue[]>([]);
  const [tableEditIndex, setTableEditIndex] = useState<number | null>(null);
  const [activeFieldKey, setActiveFieldKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');

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

  useEffect(() => {
    if (!documentId) return;
    api.getDocument(documentId).then((doc) => {
      setDocument(doc);
      setValues(doc.extractedData);
    });
  }, [documentId]);

  function updateValue(index: number, value: string) {
    const next = [...values];
    const current = next[index];
    next[index] = { ...current, value };
    setValues(next);
  }

  function updateTableValue(index: number, value: Record<string, unknown>[]) {
    const next = [...values];
    next[index] = { ...next[index], value };
    setValues(next);
  }

  async function submit() {
    if (!document) return;
    const normalized = values.map((item) => {
      if (item.type !== 'table') return item;
      try {
        return { ...item, value: JSON.parse(String(item.value)) };
      } catch {
        return item;
      }
    });
    await api.validateDocument(document._id, normalized);
    setMessage('Document validated');
    await onValidated();
  }

  if (!documentId) return <EmptyState text="Select a document from the list." />;
  if (!document) return <EmptyState text="Loading document." />;

  const isValidated = document.status === 'validated';

  return (
    <div className="validation-layout">
      <section className="pdf-pane">
        <PdfViewer
          url={api.documentFileUrl(document._id)}
          highlights={values.flatMap((item, index) => {
            const styles = fieldStyles[item.key];
            return (item.boundingBoxes || []).map((box) => ({
              ...box,
              fieldKey: item.key,
              color: styles?.border || 'rgba(59, 130, 246, 0.8)',
              activeFill: styles?.activeFill || 'rgba(59, 130, 246, 0.25)',
            }));
          })}
          activeFieldKey={activeFieldKey}
        />
      </section>
      <section className="panel extraction-pane">
        <div className="panel-heading">
          <div>
            <h2>{document.originalName}</h2>
            <p>{document.category} / {document.documentTypeName}</p>
          </div>
          <span className={`pill ${document.status}`}>{document.status}</span>
        </div>
        {message && <div className="toast inline">{message}</div>}
        <div className="extraction-form">
          {values.map((item, index) => {
            const styles = fieldStyles[item.key];
            const isActive = item.key === activeFieldKey;
            const wrapperStyle = {
              borderColor: styles?.border,
              backgroundColor: isActive ? styles?.activeFill : styles?.fill,
            } as const;

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
                <TableValuePreview item={item} canEdit={!isValidated} onEdit={() => setTableEditIndex(index)} />
              </div>
            ) : (
              <label
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
                <input
                  value={coerceValue(item.value)}
                  disabled={isValidated}
                  onChange={(event) => updateValue(index, event.target.value)}
                />
              </label>
            );
          })}
        </div>
        {isValidated ? (
          <div className="locked-state">
            <CheckCircle2 size={16} />
            Validated documents are locked.
          </div>
        ) : (
          <button className="primary-button" type="button" onClick={submit}>
            <CheckCircle2 size={16} />
            Submit Validation
          </button>
        )}
      </section>
      {tableEditIndex !== null && values[tableEditIndex] && (
        <TableEditDialog
          item={values[tableEditIndex]}
          onClose={() => setTableEditIndex(null)}
          onSave={(rows) => {
            updateTableValue(tableEditIndex, rows);
            setTableEditIndex(null);
          }}
        />
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
      targetPageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

      setTimeout(() => {
        const activeHighlights = targetPageElement.querySelectorAll('.pdf-highlight.active');
        if (activeHighlights.length > 0) {
          (activeHighlights[0] as HTMLElement).focus({ preventScroll: true });
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
