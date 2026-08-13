import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusAdministrationClient, ServiceBusClient } from '@azure/service-bus';
import { Connection } from 'mongoose';
import { ConfigurationService } from '../configuration/configuration.service';

export type HealthStatus = 'ready' | 'unavailable' | 'not_configured';

export type HealthCheck = {
  id: string;
  name: string;
  group: 'Application' | 'Data' | 'Storage' | 'Queues' | 'Services' | 'AI';
  status: HealthStatus;
  detail: string;
  latencyMs: number;
};

@Injectable()
export class HealthService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly configurationService: ConfigurationService,
  ) {}

  async checkAll() {
    const configuration = await this.configurationService.get();
    const storageConnection = process.env.AZURE_STORAGE_CONNECTION_STRING ?? process.env.AzureWebJobsStorage;
    const vectorDatabaseUrl = (configuration.vectorDatabaseEndpoint || process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
    const vectorDatabaseHeaders = configuration.vectorDatabaseApiKey
      ? { 'api-key': configuration.vectorDatabaseApiKey }
      : undefined;
    const realtimeUrl = process.env.REALTIME_HEALTH_URL
      || this.healthUrlFromEndpoint(process.env.REALTIME_BROADCAST_URL, '/health');
    const processorUrl = process.env.PROCESSOR_HEALTH_URL || 'http://127.0.0.1:7071/admin/host/status';
    const doclingEndpoint = configuration.markdownServiceUrl || process.env.DOCLING_MARKDOWN_SERVICE_URL;
    const doclingUrl = process.env.DOCLING_HEALTH_URL
      || this.healthUrlFromEndpoint(doclingEndpoint, '/admin/host/status');

    const checks: Array<Promise<HealthCheck>> = [
      Promise.resolve({
        id: 'api',
        name: 'Xtract API',
        group: 'Application',
        status: 'ready',
        detail: 'API is responding.',
        latencyMs: 0,
      }),
      this.timed('mongodb', 'MongoDB', 'Data', async () => {
        await this.connection.db?.admin().ping();
        return 'Database connection is ready.';
      }),
      this.httpCheck(
        'qdrant',
        `${configuration.vectorDatabaseProvider || 'Qdrant'} vector database`,
        'Data',
        `${vectorDatabaseUrl}/healthz`,
        vectorDatabaseHeaders,
      ),
      this.httpCheck('processor', 'Document processor Functions', 'Services', processorUrl),
      this.httpCheck('realtime', 'Self-hosted SignalR', 'Services', realtimeUrl),
      this.httpCheck('docling', 'Docling markdown service', 'Services', doclingUrl),
      this.aiCheck(configuration),
      this.embeddingCheck(configuration),
    ];

    if (storageConnection) {
      checks.push(
        this.timed('blob-storage', 'Blob storage', 'Storage', async () => {
          await BlobServiceClient.fromConnectionString(storageConnection).getProperties();
          return 'Blob service is reachable.';
        }),
      );
      for (const containerName of ['processing', 'train', 'trigger']) {
        checks.push(this.timed(`container-${containerName}`, `${containerName} container`, 'Storage', async () => {
          const container = BlobServiceClient
            .fromConnectionString(storageConnection)
            .getContainerClient(containerName);
          if (!(await container.exists())) throw new Error('Container does not exist.');
          return 'Blob container is ready.';
        }));
      }
    } else {
      checks.push(Promise.resolve(this.notConfigured('blob-storage', 'Blob storage', 'Storage')));
    }

    checks.push(...this.serviceBusChecks());

    const results = await Promise.all(checks);
    const ready = results.filter((check) => check.status === 'ready').length;
    const unavailable = results.filter((check) => check.status === 'unavailable').length;
    const notConfigured = results.filter((check) => check.status === 'not_configured').length;
    return {
      status: unavailable ? 'degraded' : 'ready',
      checkedAt: new Date().toISOString(),
      summary: { total: results.length, ready, unavailable, notConfigured },
      checks: results,
    };
  }

  private serviceBusChecks(): Array<Promise<HealthCheck>> {
    const queueNames = [
      'blob-ingestion',
      'document-processing',
      'document-classification',
      'document-extraction',
      'classifier-training',
      'document-events',
    ];
    const connectionString = process.env.SERVICE_BUS_CONNECTION_STRING;
    const namespace = process.env.SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE;
    if (!connectionString && !namespace) {
      return [
        Promise.resolve(this.notConfigured('service-bus', 'Service Bus', 'Services')),
        ...queueNames.map((name) => Promise.resolve(this.notConfigured(`queue-${name}`, name, 'Queues'))),
      ];
    }
    if (connectionString?.includes('UseDevelopmentEmulator=true')) {
      const client = new ServiceBusClient(connectionString);
      const queueChecks = queueNames.map((name) => this.timed(`queue-${name}`, name, 'Queues', async () => {
        const receiver = client.createReceiver(name, { receiveMode: 'peekLock' });
        try {
          await receiver.peekMessages(1);
          return 'Queue exists and is reachable.';
        } finally {
          await receiver.close().catch(() => undefined);
        }
      }));
      const serviceCheck = this.timed('service-bus', 'Service Bus', 'Services', async () => {
        try {
          const results = await Promise.all(queueChecks);
          const missing = results.filter((check) => check.status !== 'ready').map((check) => check.name);
          if (missing.length) throw new Error(`Missing or unreachable queue(s): ${missing.join(', ')}.`);
          return `Service Bus is ready. All ${queueNames.length} required queues exist.`;
        } finally {
          await client.close().catch(() => undefined);
        }
      });
      return [serviceCheck, ...queueChecks];
    }
    const admin = connectionString
      ? new ServiceBusAdministrationClient(connectionString)
      : new ServiceBusAdministrationClient(namespace!, new DefaultAzureCredential());
    const queueChecks = queueNames.map((name) => this.timed(`queue-${name}`, name, 'Queues', async () => {
      const properties = await admin.getQueueRuntimeProperties(name);
      return `${properties.activeMessageCount} active message(s).`;
    }));
    const serviceCheck = this.timed('service-bus', 'Service Bus', 'Services', async () => {
      const results = await Promise.all(queueChecks);
      const missing = results.filter((check) => check.status !== 'ready').map((check) => check.name);
      if (missing.length) throw new Error(`Missing or unreachable queue(s): ${missing.join(', ')}.`);
      const activeMessages = results.reduce((total, result) => (
        total + (Number.parseInt(result.detail, 10) || 0)
      ), 0);
      return `Service Bus is ready. All ${queueNames.length} required queues exist; ${activeMessages} active message(s).`;
    });
    return [serviceCheck, ...queueChecks];
  }

  private aiCheck(configuration: Awaited<ReturnType<ConfigurationService['get']>>) {
    if (configuration.aiProvider === 'ollama') {
      return this.httpCheck(
        'ai-provider',
        'Ollama AI provider',
        'AI',
        `${(configuration.ollamaBaseUrl || '').replace(/\/$/, '')}/api/tags`,
      );
    }
    return this.openAiCheck(
      'ai-provider',
      configuration.aiProvider === 'custom' ? 'Custom AI provider' : 'OpenAI provider',
      (configuration as any).apiKey,
      configuration.aiProvider === 'custom' ? (configuration as any).llmEndpoint : undefined,
    );
  }

  private embeddingCheck(configuration: Awaited<ReturnType<ConfigurationService['get']>>) {
    if (configuration.embeddingProvider === 'ollama') {
      return this.httpCheck(
        'embedding-provider',
        'Ollama embedding provider',
        'AI',
        `${(configuration.ollamaBaseUrl || '').replace(/\/$/, '')}/api/tags`,
      );
    }
    return this.openAiCheck(
      'embedding-provider',
      'OpenAI-compatible embedding provider',
      (configuration as any).apiKey,
      configuration.aiProvider === 'custom' ? (configuration as any).llmEndpoint : undefined,
    );
  }

  private openAiCheck(id: string, name: string, apiKey?: string, endpoint?: string): Promise<HealthCheck> {
    if (!apiKey) return Promise.resolve(this.notConfigured(id, name, 'AI', 'An API key is not configured.'));
    return this.httpCheck(id, name, 'AI', `${(endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`, {
      Authorization: `Bearer ${apiKey}`,
    });
  }

  private httpCheck(
    id: string,
    name: string,
    group: HealthCheck['group'],
    url?: string,
    headers?: Record<string, string>,
  ): Promise<HealthCheck> {
    if (!url || url.startsWith('/')) {
      return Promise.resolve(this.notConfigured(id, name, group));
    }
    return this.timed(id, name, group, async () => {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      return `Service responded with HTTP ${response.status}.`;
    });
  }

  private async timed(
    id: string,
    name: string,
    group: HealthCheck['group'],
    action: () => Promise<string>,
  ): Promise<HealthCheck> {
    const startedAt = performance.now();
    try {
      const detail = await action();
      return {
        id,
        name,
        group,
        status: 'ready',
        detail,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        id,
        name,
        group,
        status: 'unavailable',
        detail: error instanceof Error ? error.message : String(error),
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
  }

  private notConfigured(
    id: string,
    name: string,
    group: HealthCheck['group'],
    detail = 'Resource is not configured.',
  ): HealthCheck {
    return { id, name, group, status: 'not_configured', detail, latencyMs: 0 };
  }

  private healthUrlFromEndpoint(endpoint: string | undefined, healthPath: string) {
    if (!endpoint) return undefined;
    try {
      const url = new URL(endpoint);
      url.pathname = healthPath;
      url.search = '';
      return url.toString();
    } catch {
      return undefined;
    }
  }
}
