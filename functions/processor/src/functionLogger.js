const { AsyncLocalStorage } = require('async_hooks');
const { randomUUID } = require('crypto');

const currentLogger = new AsyncLocalStorage();
const levels = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace']);

function documentIdFromMessage(message) {
  if (Buffer.isBuffer(message)) message = message.toString('utf8');
  if (typeof message === 'string') {
    try { message = JSON.parse(message); } catch { message = { documentId: message }; }
  }
  const id = message?.documentId || message?.id;
  return typeof id === 'string' && /^[a-f\d]{24}$/i.test(id) ? id : undefined;
}

class FunctionLogger {
  constructor(context, documentId) {
    this.context = context;
    const invocationId = context.invocationId && context.invocationId !== 'unknown' ? context.invocationId : randomUUID();
    this.correlationId = documentId || `invocation:${invocationId}`;
  }

  setDocumentId(documentId) {
    const id = String(documentId);
    if (/^[a-f\d]{24}$/i.test(id)) this.correlationId = id;
  }

  write(level, ...args) {
    this.context[level](`[correlationId=${this.correlationId}] ${args[0] ?? ''}`, ...args.slice(1));
  }

  scopedContext() {
    return new Proxy(this.context, {
      get: (target, property) => {
        if (property === 'functionLogger') return this;
        if (levels.has(property)) return (...args) => this.write(property, ...args);
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

function withFunctionLogging(name, source, handler, { documentMessage = false } = {}) {
  return async (message, context) => {
    const logger = new FunctionLogger(context, documentMessage ? documentIdFromMessage(message) : undefined);
    const started = Date.now();
    return currentLogger.run(logger, async () => {
      logger.write('info', `Function ${name} started (source=${source}).`);
      try {
        const result = await handler(message, logger.scopedContext());
        logger.write('info', `Function ${name} returned (durationMs=${Date.now() - started}).`);
        return result;
      } catch (error) {
        const errorType = typeof error?.name === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,80}$/.test(error.name) ? error.name : 'Error';
        logger.write('error', `Function ${name} threw (durationMs=${Date.now() - started}, errorType=${errorType}).`);
        throw error;
      }
    });
  };
}

function getFunctionLogger() {
  return currentLogger.getStore();
}

module.exports = { FunctionLogger, getFunctionLogger, withFunctionLogging };
