export type FieldType = 'string' | 'number' | 'date' | 'currency' | 'boolean' | 'table';

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
  classifierTrainingError?: string;
  fields: ExtractionField[];
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
  category: string;
  documentTypeId: string;
  documentTypeName: string;
  classificationScore?: number;
  classificationMethod?: 'manual' | 'vector' | 'llm';
  status: 'uploaded' | 'processing' | 'extracted' | 'validated' | 'rejected' | 'failed';
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
  documentsWithRecordedUsage: number;
  recentDocuments: Array<{
    id: string;
    name: string;
    status: IncomingDocument['status'];
    tokens: number;
    estimatedCostUsd: number;
    processedAt: string;
  }>;
};

export type PagedResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
