import { GoogleGenAI } from '@google/genai';

const answerSchema = {
  type: 'OBJECT',
  properties: {
    answer: { type: 'STRING' },
    citations: { type: 'ARRAY', items: { type: 'OBJECT', properties: { evidenceId: { type: 'STRING' }, explanation: { type: 'STRING' } }, required: ['evidenceId', 'explanation'] } },
    insufficientEvidence: { type: 'BOOLEAN' }
  },
  required: ['answer', 'citations', 'insufficientEvidence']
};

export function createGeminiLlmService({ config, client } = {}) {
  const ai = client ?? (config?.apiKey ? new GoogleGenAI({ apiKey: config.apiKey }) : null);
  function scrub(value) {
    let text = String(value ?? '').slice(0, 2000);
    if (config?.apiKey) text = text.split(config.apiKey).join('[REDACTED]');
    return text
      .replace(/(\b(?:authorization|cookie|set-cookie|x-goog-api-key)\b\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
      .replace(/\bAIza[\w-]{20,}\b/g, '[REDACTED]');
  }
  function providerDetails(error) {
    const response = error?.response;
    const body = response?.data ?? response?.body ?? error?.error;
    if (!body || typeof body !== 'object') return undefined;
    const details = {};
    for (const key of ['code', 'status', 'statusCode', 'message', 'type', 'reason']) {
      const value = body[key];
      if (typeof value === 'string' || typeof value === 'number') details[key] = scrub(value);
    }
    const nested = body.error;
    if (nested && typeof nested === 'object') {
      for (const key of ['code', 'status', 'message', 'statusCode', 'type', 'reason']) {
        const value = nested[key];
        if (typeof value === 'string' || typeof value === 'number') details[`error_${key}`] = scrub(value);
      }
      if (Array.isArray(nested.details)) details.details = nested.details.slice(0, 8).map((item) => {
        if (!item || typeof item !== 'object') return scrub(item);
        return Object.fromEntries(Object.entries(item)
          .filter(([key, value]) => !/prompt|content|authorization|cookie|api.?key|token|source|snippet/i.test(key) && ['string', 'number', 'boolean'].includes(typeof value))
          .slice(0, 12).map(([key, value]) => [key, typeof value === 'string' ? scrub(value) : value]));
      });
    }
    return Object.keys(details).length ? details : undefined;
  }
  function ready() {
    if (!ai) {
      const error = new Error('Gemini is not configured. Set LLM_API_KEY in the backend environment.');
      error.safe = true;
      error.status = 503;
      error.code = 'LLM_NOT_CONFIGURED';
      error.providerDiagnostics = { category: 'invalid_configuration', name: error.name, message: error.message, code: error.code };
      throw error;
    }
  }
  function providerError(error) {
    if (error?.safe) return error;
    const status = Number(error?.status ?? error?.statusCode);
    const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    const details = String(error?.message ?? '').toLowerCase();
    const blocked = status === 400 && (details.includes('safety') || details.includes('block'));
    const unauthenticated = status === 401 || status === 403;
    const missingModel = status === 404;
    const network = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code);
    const invalidModel = status === 400 && /model|model.?name/i.test(details);
    const category = timeout ? 'timeout' : status === 429 ? 'quota_or_rate_limit' : unauthenticated ? 'authentication' : missingModel || invalidModel ? 'model_configuration' : blocked ? 'safety_block' : network ? 'network' : 'provider_failure';
    const result = new Error(timeout ? 'The answer request timed out. Please try again.' : status === 429 ? 'Gemini is rate limited or its quota is exhausted. Check the current Google AI Studio limits and try again later.' : blocked ? 'Gemini could not answer because its safety filters blocked the request.' : unauthenticated ? 'Gemini authentication failed. Check the backend LLM_API_KEY configuration.' : missingModel ? 'The configured Gemini model is unavailable. Check LLM_MODEL.' : 'The answer provider is temporarily unavailable. Please try again later.');
    result.safe = true;
    result.status = timeout ? 504 : status === 429 ? 429 : blocked ? 422 : 503;
    result.code = timeout ? 'LLM_TIMEOUT' : status === 429 ? 'LLM_RATE_LIMITED' : blocked ? 'LLM_SAFETY_BLOCKED' : unauthenticated ? 'LLM_AUTHENTICATION_FAILED' : missingModel || invalidModel ? 'LLM_MODEL_UNAVAILABLE' : 'LLM_UNAVAILABLE';
    result.providerDiagnostics = {
      category,
      name: scrub(error?.name || 'Error'),
      message: scrub(error?.message || 'Unknown provider error'),
      code: scrub(error?.code || ''),
      status: Number.isFinite(status) ? status : undefined,
      response: providerDetails(error)
    };
    return result;
  }
  return {
    async generateJson(prompt, signal, systemInstruction) {
      ready();
      try {
        const response = await ai.models.generateContent({
          model: config.model,
          contents: prompt,
          config: { responseMimeType: 'application/json', responseJsonSchema: answerSchema, maxOutputTokens: config.maxOutputTokens, abortSignal: signal, ...(systemInstruction ? { systemInstruction } : {}) }
        });
        const text = response.text;
        if (!text) throw new Error('Gemini returned no answer.');
        return JSON.parse(text);
      } catch (error) {
        if (error instanceof SyntaxError) { const malformed = new Error('The answer provider returned an invalid response. Please try again.'); malformed.safe = true; malformed.status = 502; malformed.code = 'LLM_INVALID_RESPONSE'; malformed.providerDiagnostics = { category: 'malformed_response', name: error.name, message: scrub(error.message), code: error.code }; throw malformed; }
        throw providerError(error);
      }
    },
    async *streamText(prompt, signal, systemInstruction) {
      ready();
      try {
        const stream = await ai.models.generateContentStream({ model: config.model, contents: prompt, config: { maxOutputTokens: config.maxOutputTokens, abortSignal: signal, ...(systemInstruction ? { systemInstruction } : {}) } });
        for await (const part of stream) if (part.text) yield part.text;
      } catch (error) { throw providerError(error); }
    }
  };
}
