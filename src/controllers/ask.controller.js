import { HttpError } from '../lib/http-error.js';
import { hybridSearch } from '../services/hybrid-search.service.js';
import { RAG_SYSTEM_INSTRUCTION, buildRagPrompt, citationsFromStream, prepareEvidence, validateAnswer } from '../services/rag-context.service.js';

const insufficientAnswer = 'The retrieved code evidence does not contain enough information to answer this question.';

function safeLogText(value, apiKey) {
  let text = String(value ?? '').slice(0, 2000);
  if (apiKey) text = text.split(apiKey).join('[REDACTED]');
  return text.replace(/(\b(?:authorization|cookie|set-cookie|x-goog-api-key)\b\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\bAIza[\w-]{20,}\b/g, '[REDACTED]');
}

function logAskFailure(error, config, { timedOut = false } = {}) {
  const diagnostics = error?.providerDiagnostics;
  const code = error?.code ?? 'UNEXPECTED_ERROR';
  const providerFailure = Boolean(diagnostics || String(code).startsWith('LLM_'));
  const category = timedOut ? 'timeout' : diagnostics?.category ?? (code === 'LLM_INVALID_RESPONSE' ? 'malformed_response' : 'provider_failure');
  const entry = {
    category,
    name: safeLogText(diagnostics?.name ?? error?.name ?? 'Error', config?.llm?.apiKey),
    message: safeLogText(diagnostics?.message ?? error?.message ?? 'Unknown error', config?.llm?.apiKey),
    code: safeLogText(diagnostics?.code ?? (timedOut ? 'LLM_TIMEOUT' : code), config?.llm?.apiKey),
    status: Number.isFinite(Number(diagnostics?.status ?? (timedOut ? 504 : error?.status))) ? Number(diagnostics?.status ?? (timedOut ? 504 : error?.status)) : null
  };
  if (diagnostics?.response) entry.providerResponse = diagnostics.response;
  console.warn(providerFailure ? 'RAG answer provider failed' : 'RAG request failed', entry);
}

export function createAskController({ prisma, embeddingService, llmService, config }) {
  return {
    async ask(req, res, next) {
      const question = req.body?.question;
      const stream = req.body?.stream ?? false;
      if (typeof req.params.repositoryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.repositoryId)) return next(new HttpError(400, 'INVALID_REPOSITORY_ID', 'Repository ID must be a valid UUID.'));
      if (typeof question !== 'string' || !question.trim() || question.length > config.rag.maxQuestionLength) return next(new HttpError(400, 'INVALID_QUESTION', `Question must contain between 1 and ${config.rag.maxQuestionLength} characters.`));
      if (typeof stream !== 'boolean') return next(new HttpError(400, 'INVALID_STREAM_OPTION', 'The stream option must be true or false.'));
      if (stream && !config.rag.enableStreaming) return next(new HttpError(400, 'STREAMING_DISABLED', 'Streaming is disabled by server configuration.'));
      try {
        const cleanQuestion = question.trim();
        const retrieval = await hybridSearch({ prisma, embeddingService, config, repositoryId: req.params.repositoryId, userId: req.auth.userId, query: cleanQuestion, limit: config.rag.retrievalLimit });
        if (retrieval.notFound) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Imported repository was not found.');
        if (retrieval.unavailable) throw new HttpError(409, 'PARSING_REQUIRED', 'Complete repository parsing before asking a question.');
        if (retrieval.embeddingsMissing) throw new HttpError(409, 'EMBEDDINGS_NOT_READY', 'Generate embeddings for the latest parsing job before asking a question.');
        const contextBudget = Math.max(1, config.rag.maxContextTokens - Math.ceil(cleanQuestion.length / 4) - 1000);
        const { evidence, context } = prepareEvidence(retrieval.results, contextBudget);
        if (!evidence.length) return res.json({ repositoryId: req.params.repositoryId, question: cleanQuestion, answer: insufficientAnswer, citations: [], insufficientEvidence: true, parsingJobId: retrieval.parsingJobId });
        if (stream) return await streamAnswer({ req, res, llmService, evidence, question: cleanQuestion, context, repositoryId: req.params.repositoryId, parsingJobId: retrieval.parsingJobId, timeoutMs: config.llm.requestTimeoutMs, apiKey: config.llm.apiKey });
        const generated = await llmService.generateJson(buildRagPrompt(cleanQuestion, context), AbortSignal.timeout(config.llm.requestTimeoutMs), RAG_SYSTEM_INSTRUCTION);
        let answer;
        try { answer = validateAnswer(generated, evidence); } catch (cause) {
          const invalid = new HttpError(502, 'LLM_INVALID_RESPONSE', 'The answer provider returned an invalid response. Please try again.');
          invalid.providerDiagnostics = { category: 'malformed_response', name: cause?.name ?? 'Error', message: safeLogText(cause?.message ?? 'Response validation failed', config.llm.apiKey), code: invalid.code, status: invalid.status };
          throw invalid;
        }
        res.json({ repositoryId: req.params.repositoryId, question: cleanQuestion, ...answer, parsingJobId: retrieval.parsingJobId });
      } catch (error) {
        if (error instanceof HttpError) {
          if (String(error.code).startsWith('LLM_')) {
            logAskFailure(error, config);
            error.logged = true;
          }
          return next(error);
        }
        logAskFailure(error, config);
        if (error?.safe) {
          const responseError = new HttpError(error.status, error.code, error.message);
          responseError.logged = true;
          return next(responseError);
        }
        const responseError = new HttpError(503, 'RAG_UNAVAILABLE', 'Question answering is temporarily unavailable. Please try again later.');
        responseError.logged = true;
        next(responseError);
      }
    }
  };
}

async function streamAnswer({ req, res, llmService, evidence, question, context, repositoryId, parsingJobId, timeoutMs, apiKey }) {
  const controller = new AbortController();
  let timedOut = false;
  let clientDisconnected = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onClose = () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort();
    }
  };
  res.on('close', onClose);
  res.status(200);
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send('start', { repositoryId, parsingJobId });
  let answer = '';
  try {
    const prompt = `${buildRagPrompt(question, context)}\n\nFor streaming, write a concise plain-text answer and cite every repository-specific claim inline using exactly [[S1]] style identifiers. Do not output file paths or line numbers.`;
    for await (const text of llmService.streamText(prompt, controller.signal, RAG_SYSTEM_INSTRUCTION)) {
      answer += text;
      send('token', { text });
    }
    let citations;
    try { citations = citationsFromStream(answer, evidence); } catch {
      const invalid = new Error('The answer provider returned an invalid response. Please try again.');
      invalid.safe = true;
      invalid.status = 502;
      invalid.code = 'LLM_INVALID_RESPONSE';
      invalid.providerDiagnostics = { category: 'malformed_response', name: 'CitationValidationError', message: 'Generated answer contained an invalid citation reference.', code: invalid.code, status: invalid.status };
      throw invalid;
    }
    let insufficientEvidence = false;
    if (!citations.length) {
      const generated = await llmService.generateJson(
        `${buildRagPrompt(question, context)}\n\nAnswer concisely from the supplied evidence. Cite every repository-specific claim in the answer using exactly [[S1]] identifiers, and include those same identifiers in the citations array.`,
        controller.signal,
        RAG_SYSTEM_INSTRUCTION
      );
      let validated;
      try { validated = validateAnswer(generated, evidence); } catch {
        const invalid = new Error('The answer provider returned an invalid response. Please try again.');
        invalid.safe = true;
        invalid.status = 502;
        invalid.code = 'LLM_INVALID_RESPONSE';
        invalid.providerDiagnostics = { category: 'malformed_response', name: 'AnswerValidationError', message: 'Generated answer failed citation validation.', code: invalid.code, status: invalid.status };
        throw invalid;
      }
      answer = validated.citations.length ? validated.answer : insufficientAnswer;
      citations = validated.citations;
      insufficientEvidence = validated.insufficientEvidence || !citations.length;
      send('answer', { answer });
    }
    send('citations', { citations });
    send('complete', { status: 'completed', insufficientEvidence });
  } catch (error) {
    if (!clientDisconnected && !res.destroyed) {
      logAskFailure(error, { llm: { apiKey } }, { timedOut });
      if (timedOut) {
        send('error', { code: 'LLM_TIMEOUT', message: 'The answer request timed out. Please try again.', status: 504 });
      } else if (!controller.signal.aborted) {
        const status = error?.safe ? error.status : 503;
        const code = error?.safe ? error.code : 'LLM_UNAVAILABLE';
        send('error', { code, message: error?.safe ? error.message : 'Question answering is temporarily unavailable.', status });
      }
    }
  } finally {
    clearTimeout(timeout);
    res.off('close', onClose);
    if (!res.destroyed) res.end();
  }
}
