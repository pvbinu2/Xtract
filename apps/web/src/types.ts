export type FieldType = 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'table';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type DisplayCurrency = 'USD' | 'INR' | 'GBP' | 'EUR';

export type TableColumn = {
  key: string;
  label: string;
  type: FieldType;
  description?: string;
};

export type ExtractionField = TableColumn & {
  uiId?: string;
  selected: boolean;
  columns?: TableColumn[];
};

export type DocumentType = {
  _id: string;
  category: string;
  name: string;
  prompt: string;
  sampleFiles: string[];
  includeInClassification?: boolean;
  classifierTrainingStatus?: 'untrained' | 'training' | 'trained' | 'failed';
  classifierProfile?: string;
  classifierTrainedAt?: string;
  classifierTrainedBy?: string;
  classifierTrainingError?: string;
  fields: ExtractionField[];
  extractionModel?: string;
  extractionReasoningEffort?: ReasoningEffort;
  extractionVerification?: boolean;
  finalized: boolean;
};

export type ExtractedValue = {
  key: string;
  label: string;
  type: FieldType;
  value: unknown;
  confidence?: number;
  boundingBoxes?: Array<{
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
};

export type IncomingDocument = {
  _id: string;
  fileName: string;
  originalName: string;
  mimeType?: string;
  textArtifactBlobName?: string;
  textArtifactMode?: 'ocr' | 'markdown';
  stageTimings?: Array<{
    status: IncomingDocument['status'];
    startTime: string;
    endTime?: string;
  }>;
  category: string;
  documentTypeId: string;
  documentTypeName: string;
  classificationScore?: number;
  classificationMethod?: 'manual' | 'vector' | 'llm' | 'rag';
  classificationModel?: string;
  classificationJustification?: string;
  classificationCandidates?: Array<{
    documentTypeId: string;
    category: string;
    name: string;
    score: number;
  }>;
  processingMode?: 'ocr' | 'pdf' | 'markdown';
  processingMetrics?: {
    model?: string;
  };
  status:
    | 'received'
    | 'preprocessed'
    | 'classified'
    | 'extracted'
    | 'validated'
    | 'rejected'
    | 'failed'
    | 'uploaded'
    | 'processing';
  revision?: number;
  extractedData: ExtractedValue[];
  createdAt: string;
  updatedAt: string;
};

export type BusinessReviewSummary = {
  totalFiles: number;
  filesProcessed: number;
  filesProcessing: number;
  filesFailed: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  estimatedCostUsd: number;
  extractionCostUsd?: number;
  classificationCostUsd?: number;
  embeddingCostUsd?: number;
  documentsWithRecordedUsage: number;
  recentDocuments: Array<{
    id: string;
    name: string;
    status: IncomingDocument['status'];
    tokens: number;
    estimatedCostUsd: number;
    extractionCostUsd?: number;
    classificationModel?: string;
    extractionModel?: string;
    classificationCostUsd?: number;
    embeddingCostUsd?: number;
    processedAt: string;
  }>;
};

export type DemoRequest = {
  _id: string;
  email: string;
  phone?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type UserRole = 'admin' | 'validator';

export type AuthUser = {
  id: string;
  _id?: string;
  username: string;
  role: UserRole;
  preferredCurrency?: DisplayCurrency;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type PagedResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
