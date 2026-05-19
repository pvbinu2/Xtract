function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayFromError(error, attempt) {
  const retryAfterMs = error?.headers?.['retry-after-ms'] || error?.headers?.get?.('retry-after-ms');
  if (retryAfterMs && Number.isFinite(Number(retryAfterMs))) return Number(retryAfterMs);

  const retryAfter = error?.headers?.['retry-after'] || error?.headers?.get?.('retry-after');
  if (retryAfter && Number.isFinite(Number(retryAfter))) return Number(retryAfter) * 1000;

  const message = error?.message || String(error);
  const msMatch = message.match(/try again in\s+(\d+)ms/i);
  if (msMatch) return Number(msMatch[1]);

  const secondMatch = message.match(/try again in\s+([\d.]+)s/i);
  if (secondMatch) return Number(secondMatch[1]) * 1000;

  return Math.min(30000, 1000 * 2 ** attempt);
}

function isRetryableOpenAIError(error) {
  const status = error?.status || error?.code;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function withOpenAIRetry(operation, label = 'OpenAI request') {
  const maxAttempts = Number(process.env.OPENAI_MAX_RETRIES || 8);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableOpenAIError(error) || attempt === maxAttempts - 1) throw error;

      const jitter = Math.floor(Math.random() * 250);
      const delay = retryDelayFromError(error, attempt) + jitter;
      console.warn(`${label} rate-limited or temporarily unavailable. Retrying in ${delay}ms.`);
      await sleep(delay);
    }
  }

  throw lastError;
}

module.exports = { withOpenAIRetry };
