function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

class ConfigurationCache {
  constructor(options) {
    if (!options?.loader) throw new Error('ConfigurationCache requires a loader.');
    this.loader = options.loader;
    this.ttlMs = positiveNumber(options.ttlMs, 30000);
    this.logger = options.logger || console;
    this.value = undefined;
    this.expiresAt = 0;
    this.loadPromise = undefined;
    this.settingsKnown = false;
    this.enabled = true;
  }

  async get() {
    if (this.settingsKnown && !this.enabled) return this.load(false);
    if (this.value !== undefined && Date.now() < this.expiresAt) return this.value;
    if (!this.loadPromise) {
      this.loadPromise = this.load(true).finally(() => { this.loadPromise = undefined; });
    }
    return this.loadPromise;
  }

  async load(allowStale) {
    try {
      return this.replace(await this.loader());
    } catch (error) {
      if (allowStale && this.enabled && this.value !== undefined) {
        this.logger.warn?.(`Configuration refresh failed; using stale in-memory configuration: ${error?.message || String(error)}`);
        return this.replace(this.value);
      }
      throw error;
    }
  }

  replace(value) {
    this.settingsKnown = true;
    this.enabled = value?.cachingEnabled !== false;
    const configuredTtlMs = positiveNumber(value?.configurationCacheTtlSeconds, this.ttlMs / 1000) * 1000;
    this.value = value;
    this.expiresAt = this.enabled ? Date.now() + configuredTtlMs : 0;
    return value;
  }

  invalidate() {
    this.expiresAt = 0;
  }
}

module.exports = { ConfigurationCache };
