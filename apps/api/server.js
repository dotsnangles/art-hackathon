import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, extname } from 'node:path';
import { DEFAULT_LLM_PROVIDER, LLM_PROVIDERS, QueryGenerationError, generateQueries } from './llm.js';

const COUNT_PARAMETERS = {
  goodCount: { defaultValue: 30, max: 100 },
  awesomeCount: { defaultValue: 3, max: 100 },
  awesomeQueryCount: { defaultValue: 10, max: 20 },
};
const DEFAULT_DIRECTION = '원문을 출발점으로 분야·관점·맥락을 과감하게 넘나들며, 뒤로 갈수록 거의 다른 주제로 도약';
const EMPTY_RESULTS_ERROR = "Google hasn't returned any results for this query.";

function limitConcurrency(limit, signal) {
  let active = 0;
  const queue = [];
  signal.addEventListener('abort', () => {
    for (const job of queue.splice(0)) job.reject(signal.reason);
  }, { once: true });

  function drain() {
    while (!signal.aborted && active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return task();
      }).then(resolve, reject).finally(() => {
        active--;
        drain();
      });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    queue.push({ task, resolve, reject });
    drain();
  });
}

function collectResults(pages, target, limit) {
  target.length = 0;
  const seenUrls = new Set();
  for (const [page, data] of [...pages].sort(([a], [b]) => a - b)) {
    for (const [index, row] of (data.organic_results ?? []).entries()) {
      if (target.length === limit) return;
      if (typeof row?.link !== 'string' || !row.link.trim() || seenUrls.has(row.link)) continue;
      seenUrls.add(row.link);
      target.push({
        url: row.link,
        title: typeof row.title === 'string' ? row.title : '',
        description: typeof row.snippet === 'string' ? row.snippet : '',
        image: typeof row.thumbnail === 'string' ? row.thumbnail : '',
        rank: (page - 1) * 10
          + (Number.isInteger(row.position) && row.position > 0 ? row.position : index + 1),
      });
    }
  }
}

export async function search(query, {
  apiKey,
  llmProvider = DEFAULT_LLM_PROVIDER,
  anthropicApiKey,
  anthropicModel,
  openaiApiKey,
  openaiModel,
  goodCount = COUNT_PARAMETERS.goodCount.defaultValue,
  awesomeCount = COUNT_PARAMETERS.awesomeCount.defaultValue,
  awesomeQueryCount = COUNT_PARAMETERS.awesomeQueryCount.defaultValue,
  awesomeDirection = DEFAULT_DIRECTION,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  signal: requestSignal,
} = {}) {
  const result = { good: [], awesome: {} };
  const awesomeEnabled = awesomeCount > 0 && awesomeQueryCount > 0;
  if (goodCount === 0 && !awesomeEnabled) return result;

  const controller = new AbortController();
  const { signal } = controller;
  const abortRequest = () => controller.abort(requestSignal.reason);
  if (requestSignal?.aborted) abortRequest();
  else requestSignal?.addEventListener('abort', abortRequest, { once: true });
  const runSerp = limitConcurrency(5, signal);
  const good = { query, count: goodCount, pages: new Map(), results: result.good };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  async function fetchPage(searchQuery, page) {
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({
      engine: 'google', q: searchQuery, hl: 'ko', gl: 'kr', tbs: 'li:1', no_cache: 'true', api_key: apiKey,
      ...(page > 1 ? { start: String((page - 1) * 10) } : {}),
    }).toString();
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error('SerpApi HTTP error');
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid SerpApi response');
    }
    const emptySuccess = data.search_metadata?.status === 'Success'
      && data.search_information?.organic_results_state === 'Fully empty'
      && data.error === EMPTY_RESULTS_ERROR;
    if ((data.error && !emptySuccess) || data.search_metadata?.status === 'Error') {
      throw new Error('SerpApi search error');
    }
    if (data.organic_results !== undefined && !Array.isArray(data.organic_results)) {
      throw new Error('Invalid SerpApi organic results');
    }
    return data;
  }

  async function fetchGroup(group) {
    for (let page = 1; page <= Math.ceil(group.count / 10); page++) {
      const data = await runSerp(() => fetchPage(group.query, page));
      signal.throwIfAborted();
      group.pages.set(page, data);
      collectResults(group.pages, group.results, group.count);
      if (group.results.length === group.count || !data.organic_results?.length) break;
    }
  }

  async function fetchAwesome() {
    if (!awesomeEnabled) return;
    const queries = await generateQueries(query, {
      llmProvider, anthropicApiKey, anthropicModel, openaiApiKey, openaiModel, awesomeQueryCount,
      awesomeDirection: awesomeDirection.trim() || DEFAULT_DIRECTION,
      fetchImpl, signal,
    });
    signal.throwIfAborted();
    // fromEntries safely supports search terms such as "__proto__".
    result.awesome = Object.fromEntries(queries.map((value, index) => [
      value, { rank: index + 1, results: [] },
    ]));
    const awesomeGroups = queries.map((value) => ({
      query: value, count: awesomeCount, pages: new Map(), results: result.awesome[value].results,
    }));
    await Promise.all(awesomeGroups.map(fetchGroup));
  }

  try {
    await Promise.all([fetchGroup(good), fetchAwesome()]);
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener('abort', abortRequest);
    controller.abort();
  }
  return result;
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

const STATIC_FILES = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/API_SPEC.html', ['API_SPEC.html', 'text/html; charset=utf-8']],
]);

async function serveStatic(request, response, [file, contentType]) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }
  try {
    const body = await readFile(new URL(file, import.meta.url));
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch {
    json(response, 500, { error: 'Unable to load frontend asset' });
  }
}

const FRONTEND_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

async function serveFrontend(request, response, pathname, frontendDir) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }
  try {
    const decoded = decodeURIComponent(pathname);
    // Only the entry point and Vite's generated assets are public.
    if (decoded !== '/' && decoded !== '/index.html' && !decoded.startsWith('/assets/')) {
      return json(response, 404, { error: 'Not found' });
    }
    if (decoded.includes('\\') || decoded.includes('\0') ||
        decoded.split('/').some(part => part === '..' || part.startsWith('.'))) {
      return json(response, 404, { error: 'Not found' });
    }
    const root = await realpath(frontendDir);
    const file = await realpath(resolve(root, decoded === '/' ? 'index.html' : decoded.slice(1)));
    const child = relative(root, file);
    const contentType = FRONTEND_TYPES[extname(file)];
    if (child.startsWith('..') || isAbsolute(child) || !contentType) {
      return json(response, 404, { error: 'Not found' });
    }
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': contentType, 'Content-Length': body.length,
      'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    if (error instanceof URIError || ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
      return json(response, 404, { error: 'Not found' });
    }
    return json(response, 500, { error: 'Unable to load frontend asset' });
  }
}

export function createSearchServer(options = {}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname !== '/search' && options.frontendDir) {
        return await serveFrontend(request, response, url.pathname, options.frontendDir);
      }
      if (STATIC_FILES.has(url.pathname)) return await serveStatic(request, response, STATIC_FILES.get(url.pathname));
      if (url.pathname !== '/search') return json(response, 404, { error: 'Not found' });
      if (request.method !== 'GET') {
        return json(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      }
      const query = url.searchParams.get('query')?.trim();
      if (!query) return json(response, 400, { error: 'query is required' });
      const counts = {};
      for (const [name, { defaultValue, max }] of Object.entries(COUNT_PARAMETERS)) {
        const raw = url.searchParams.get(name);
        if (raw !== null && (!/^\d+$/.test(raw) || Number(raw) > max)) {
          return json(response, 400, { error: name + ' must be an integer from 0 to ' + max });
        }
        counts[name] = raw === null ? defaultValue : Number(raw);
      }
      const awesomeDirection = url.searchParams.get('awesomeDirection')?.trim() || DEFAULT_DIRECTION;
      const controller = new AbortController();
      const abortRequest = () => { if (!response.writableEnded) controller.abort(); };
      response.once('close', abortRequest);
      try {
        const result = await search(query, { ...options, ...counts, awesomeDirection, signal: controller.signal });
        if (!response.destroyed) json(response, 200, result);
      } finally {
        response.removeListener('close', abortRequest);
      }
    } catch (error) {
      if (response.destroyed) return;
      json(response, 502, {
        error: error instanceof QueryGenerationError ? error.message : 'SerpApi search failed',
      });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiKey = process.env.SERPAPI_API_KEY?.trim();
  const llmProvider = process.env.LLM_PROVIDER?.trim() || DEFAULT_LLM_PROVIDER;
  const providerConfig = Object.hasOwn(LLM_PROVIDERS, llmProvider) ? LLM_PROVIDERS[llmProvider] : null;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const anthropicModel = process.env.ANTHROPIC_MODEL?.trim() || LLM_PROVIDERS.anthropic.defaultModel;
  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiModel = process.env.OPENAI_MODEL?.trim() || LLM_PROVIDERS.openai.defaultModel;
  const port = Number(process.env.PORT ?? 3000);
  const startupError = !apiKey ? 'SERPAPI_API_KEY is required'
    : !providerConfig ? 'LLM_PROVIDER must be anthropic or openai'
      : !process.env[providerConfig.apiKeyEnv]?.trim() ? providerConfig.apiKeyEnv + ' is required'
        : !Number.isInteger(port) || port < 1 || port > 65535
          ? 'PORT must be an integer from 1 to 65535' : null;
  if (startupError) {
    console.error(startupError);
    process.exitCode = 1;
  } else {
    const server = createSearchServer({
      apiKey, llmProvider, anthropicApiKey, anthropicModel, openaiApiKey, openaiModel,
    });
    server.on('error', (error) => {
      console.error('Server failed to start: ' + (error.code ?? 'unknown error'));
      process.exitCode = 1;
    });
    server.listen(port, () => console.log('Query API listening on http://localhost:' + port));
  }
}
