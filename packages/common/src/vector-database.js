class QdrantVectorDatabase {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '');
    this.collectionName = options.collectionName || process.env.QDRANT_COLLECTION || 'xtract_document_classifier';
    this.fetch = options.fetch || globalThis.fetch;
  }

  async request(pathname, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`Qdrant request failed: ${response.status} ${await response.text()}`);
    return response.status === 204 ? undefined : response.json();
  }

  vectorSize(payload) {
    const vectors = payload?.result?.config?.params?.vectors;
    if (typeof vectors?.size === 'number') return vectors.size;
    if (typeof vectors?.default?.size === 'number') return vectors.default.size;
    return Object.values(vectors || {}).find((value) => typeof value?.size === 'number')?.size;
  }

  async ensureCollection(size) {
    const response = await this.fetch(`${this.baseUrl}/collections/${this.collectionName}`);
    if (response.ok) {
      const existingSize = this.vectorSize(await response.json());
      if (!existingSize || existingSize === size) return;
      throw new Error(`Qdrant collection ${this.collectionName} uses ${existingSize}-dimension vectors, but the configured embedding model returned ${size}. Reset classifier training after changing embedding models.`);
    }
    const created = await this.fetch(`${this.baseUrl}/collections/${this.collectionName}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size, distance: 'Cosine' } }),
    });
    if (!created.ok && created.status !== 409) throw new Error(`Qdrant request failed: ${created.status} ${await created.text()}`);
  }

  async resetCollection() {
    let response;
    try { response = await this.fetch(`${this.baseUrl}/collections/${this.collectionName}`, { method: 'DELETE' }); }
    catch (error) { throw new Error(`Could not reach Qdrant at ${this.baseUrl}: ${error?.message || String(error)}`); }
    if (!response.ok && response.status !== 404) throw new Error(`Qdrant collection reset failed: ${response.status} ${await response.text()}`);
  }

  async deleteByFilter(filter) {
    const existing = await this.fetch(`${this.baseUrl}/collections/${this.collectionName}`);
    if (existing.status === 404) return;
    if (!existing.ok) throw new Error(`Qdrant request failed: ${existing.status} ${await existing.text()}`);
    await this.request(`/collections/${this.collectionName}/points/delete`, { method: 'POST', body: JSON.stringify({ filter }) });
  }

  upsert(points) {
    return this.request(`/collections/${this.collectionName}/points?wait=true`, { method: 'PUT', body: JSON.stringify({ points }) });
  }

  search(vector, limit = 5) {
    return this.request(`/collections/${this.collectionName}/points/search`, {
      method: 'POST', body: JSON.stringify({ vector, limit, with_payload: true }),
    }).then((payload) => payload?.result || []);
  }
}

module.exports = { QdrantVectorDatabase };
