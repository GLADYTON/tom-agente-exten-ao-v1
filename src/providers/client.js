import { getProviderType } from './catalog.js';
import { getGithub } from '../storage.js';

// Gateways variam no header de auth: a maioria usa Bearer, alguns exigem x-api-key.
export const AUTH_SCHEMES = [
  { id: 'bearer', label: 'bearer (Authorization: Bearer <chave>)' },
  { id: 'x-api-key', label: 'x-api-key (header x-api-key: <chave>)' },
  { id: 'none', label: 'nenhum (gateway sem autenticação)' },
];

function resolveAuthScheme(provider) {
  return provider.authScheme || getProviderType(provider.type)?.authScheme || 'bearer';
}

function applyAuthHeader(headers, apiKey, scheme) {
  if (!apiKey || scheme === 'none') return headers;
  if (scheme === 'x-api-key') headers['x-api-key'] = apiKey;
  else headers['authorization'] = `Bearer ${apiKey}`;
  return headers;
}

// Proxies na frente do gateway (Apache/nginx) cortam a conexão quando o upstream
// fica ~60s sem enviar bytes e devolvem uma página HTML de erro. Sem tradução, o
// usuário via um dump de <!DOCTYPE html> no chat.
function describeHttpFailure(label, status, raw) {
  const body = (raw || '').trim();
  const looksHtml = /^<(?:!doctype|html)/i.test(body);
  const proxyTimeout = looksHtml && (status === 502 || status === 503 || status === 504);

  if (proxyTimeout) {
    return `${label} ${status}: o proxy do gateway encerrou a conexão antes do modelo responder `
      + '(timeout de leitura do upstream, normalmente 60s). A extensão já usa streaming para evitar '
      + 'isso — se persistir, reduza o tamanho da resposta (max_tokens) ou troque de modelo.';
  }
  if (looksHtml) {
    return `${label} ${status}: o gateway devolveu HTML em vez de JSON. Confira se a URL base aponta `
      + 'para a API (…/v1) e não para uma página web.';
  }
  return `${label} ${status}: ${body.slice(0, 400)}`;
}

// Lê um corpo text/event-stream linha a linha. O buffer é necessário porque um
// chunk da rede pode terminar no meio de uma linha.
async function readSSELines(res, onLine) {
  if (!res.body?.getReader) {
    // Ambientes sem streaming de corpo (alguns shims de teste): lê tudo de uma vez.
    for (const line of (await res.text()).split('\n')) onLine(line);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf) onLine(buf.replace(/\r$/, ''));
}

// Normaliza a base do gateway: aceita raiz, /v1 ou a URL completa de chat/completions.
export function gatewayBase(endpoint) {
  let base = (endpoint || '').trim().replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/, '');
  return base;
}

export function gatewayChatUrl(endpoint) {
  const base = gatewayBase(endpoint);
  if (!base) return '';
  return /\/v\d+[a-z]*$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

export function gatewayModelsUrl(endpoint) {
  const base = gatewayBase(endpoint);
  if (!base) return '';
  return /\/v\d+[a-z]*$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

function normalizeToolsForOpenAI(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function normalizeToolsForAnthropic(tools) {
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

function normalizeToolsForGemini(tools) {
  return [{ functionDeclarations: tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  })) }];
}

function toAnthropicMessages(messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content) }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        parts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: 'assistant', content: parts });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return { system, messages: out };
}

function toGeminiContents(messages) {
  const contents = [];
  let system = '';
  for (const m of messages) {
    if (m.role === 'system') { system += (system ? '\n\n' : '') + m.content; continue; }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name: m.tool_name || 'tool', response: { content: m.content } } }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls) parts.push({ functionCall: { name: tc.name, args: tc.args } });
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    });
  }
  return { system, contents };
}

async function callAnthropic(provider, model, messages, tools, opts) {
  const { system, messages: msgs } = toAnthropicMessages(messages);
  const body = {
    model: model.id,
    max_tokens: opts.maxTokens || model.maxOutput || 4096,
    messages: msgs,
    stream: opts.stream !== false,
  };
  if (system) body.system = system;
  if (tools?.length) body.tools = normalizeToolsForAnthropic(tools);
  if (opts.temperature != null) body.temperature = opts.temperature;

  const res = await fetch(provider.endpoint || 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(describeHttpFailure('Anthropic', res.status, await res.text()));
  if (!body.stream) return anthropicResultFromJson(JSON.parse(await res.text()));
  return readAnthropicSSE(res, opts.onDelta);
}

function anthropicResultFromJson(data) {
  const text = data.content?.filter(c => c.type === 'text').map(c => c.text).join('') || '';
  const toolCalls = data.content?.filter(c => c.type === 'tool_use').map(c => ({
    id: c.id, name: c.name, args: c.input,
  })) || [];
  return {
    text,
    toolCalls,
    usage: { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 },
    stop: data.stop_reason,
  };
}

async function callOpenAILike(provider, model, messages, tools, opts) {
  const msgs = messages.map(m => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content) };
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: m.content || '',
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
  // Streaming por padrão: mantém bytes trafegando para o proxy do gateway não
  // cortar a conexão com 502 durante respostas longas.
  const stream = opts.stream !== false;
  const body = { model: model.id, messages: msgs, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (opts.maxTokens || model.maxOutput) body.max_tokens = opts.maxTokens || model.maxOutput;
  if (opts.temperature != null) body.temperature = opts.temperature;
  if (tools?.length) { body.tools = normalizeToolsForOpenAI(tools); body.tool_choice = 'auto'; }

  const headers = { 'content-type': 'application/json' };
  if (stream) headers.accept = 'text/event-stream';
  let apiKey = provider.apiKey;
  if (provider.type === 'github-models') {
    const g = await getGithub();
    if (!g.token) throw new Error('GitHub Models: conecte sua conta do GitHub em Config → GitHub para usar este provider (usa seu próprio token).');
    apiKey = g.token;
  }
  applyAuthHeader(headers, apiKey, resolveAuthScheme(provider));
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders);

  // Gateways podem ter sido salvos apenas com a URL base; completa o caminho.
  const url = /\/chat\/completions$/.test((provider.endpoint || '').replace(/\/+$/, ''))
    ? provider.endpoint
    : (provider.isGateway || getProviderType(provider.type)?.authScheme
        ? gatewayChatUrl(provider.endpoint)
        : provider.endpoint);

  const res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const label = provider.name || provider.label || provider.type;
  if (!res.ok) throw new Error(describeHttpFailure(label, res.status, await res.text()));

  const data = stream
    ? await readOpenAISSE(res, opts.onDelta)
    : parseOpenAIPayload(await res.text());
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const toolCalls = (msg.tool_calls || []).map(tc => ({
    id: tc.id, name: tc.function?.name,
    args: safeParse(tc.function?.arguments),
  }));
  return {
    text: msg.content || '',
    toolCalls,
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
    stop: choice?.finish_reason,
  };
}

async function callGemini(provider, model, messages, tools, opts) {
  const { system, contents } = toGeminiContents(messages);
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = normalizeToolsForGemini(tools);
  const generationConfig = {};
  if (opts.maxTokens || model.maxOutput) generationConfig.maxOutputTokens = opts.maxTokens || model.maxOutput;
  if (opts.temperature != null) generationConfig.temperature = opts.temperature;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  const url = `${provider.endpoint.replace(/\/$/, '')}/models/${model.id}:generateContent?key=${encodeURIComponent(provider.apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(describeHttpFailure('Gemini', res.status, await res.text()));
  const data = await res.json();
  const cand = data.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts.filter(p => p.text).map(p => p.text).join('');
  const toolCalls = parts.filter(p => p.functionCall).map((p, i) => ({
    id: `gem_${Date.now()}_${i}`,
    name: p.functionCall.name,
    args: p.functionCall.args || {},
  }));
  return {
    text,
    toolCalls,
    usage: {
      input: data.usageMetadata?.promptTokenCount || 0,
      output: data.usageMetadata?.candidatesTokenCount || 0,
    },
    stop: cand?.finishReason,
  };
}

function safeParse(s) {
  try { return typeof s === 'string' ? JSON.parse(s) : (s || {}); } catch { return {}; }
}

function newOpenAIAcc() {
  return { content: '', toolCalls: [], finish: null, usage: null, id: null, model: null, error: null };
}

// Aplica um chunk (delta de streaming ou message completa) no acumulador.
function pushOpenAIChunk(acc, chunk, onDelta) {
  if (chunk.error) {
    acc.error = chunk.error.message || JSON.stringify(chunk.error).slice(0, 300);
    return;
  }

  acc.id ??= chunk.id;
  acc.model ??= chunk.model;
  if (chunk.usage) acc.usage = chunk.usage;

  const ch = chunk.choices?.[0];
  if (!ch) return;
  if (ch.finish_reason) acc.finish = ch.finish_reason;

  // Chunks de streaming usam "delta"; respostas completas usam "message".
  const part = ch.delta || ch.message || {};
  if (typeof part.content === 'string' && part.content) {
    acc.content += part.content;
    onDelta?.({ type: 'text', text: part.content, accumulated: acc.content });
  }

  for (const tc of (part.tool_calls || [])) {
    const idx = tc.index ?? acc.toolCalls.length;
    acc.toolCalls[idx] ??= { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
    const slot = acc.toolCalls[idx];
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.function.name = tc.function.name;
    if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    onDelta?.({ type: 'tool_call_partial', name: slot.function.name });
  }
}

function finishOpenAIAcc(acc) {
  return {
    id: acc.id,
    model: acc.model,
    usage: acc.usage,
    choices: [{
      index: 0,
      finish_reason: acc.finish,
      message: {
        role: 'assistant',
        content: acc.content,
        tool_calls: acc.toolCalls.filter(Boolean),
      },
    }],
  };
}

// Alguns gateways respondem text/event-stream mesmo com stream:false.
// Aceita JSON puro ou SSE, remontando os deltas em um único choice.
function parseOpenAIPayload(raw) {
  const txt = (raw || '').trim();
  if (!txt) throw new Error('Resposta vazia do provider.');

  if (!txt.startsWith('data:')) {
    try {
      return JSON.parse(txt);
    } catch {
      throw new Error(`Resposta não é JSON válido: ${txt.slice(0, 200)}`);
    }
  }

  const acc = newOpenAIAcc();
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { pushOpenAIChunk(acc, JSON.parse(payload)); } catch { continue; }
  }
  if (acc.error) throw new Error(`Erro do provider: ${acc.error}`);
  return finishOpenAIAcc(acc);
}

// Consome o SSE conforme ele chega, em vez de esperar o corpo inteiro. É isso que
// evita o 502 do proxy em respostas longas.
async function readOpenAISSE(res, onDelta) {
  const acc = newOpenAIAcc();
  let sawData = false;
  let done = false;

  await readSSELines(res, (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') { done = true; return; }
    sawData = true;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { return; }
    pushOpenAIChunk(acc, chunk, onDelta);
  });

  if (acc.error) throw new Error(`Erro do provider: ${acc.error}`);
  if (!sawData) throw new Error('O gateway abriu o stream mas não enviou nenhum dado.');

  // Stream cortado no meio (proxy/rede) sem [DONE] nem finish_reason: entregar o
  // texto parcial calado viraria uma resposta truncada passando por completa.
  if (!done && !acc.finish) {
    if (!acc.content && !acc.toolCalls.length) {
      throw new Error('A conexão com o gateway caiu antes de qualquer conteúdo chegar. Tente novamente.');
    }
    acc.finish = 'incomplete';
  }
  return finishOpenAIAcc(acc);
}

// SSE da API nativa da Anthropic: eventos separados por tipo, não deltas de choices.
async function readAnthropicSSE(res, onDelta) {
  const blocks = [];
  let text = '';
  let stop = null;
  let usage = { input: 0, output: 0 };
  let sawData = false;
  let errorMsg = null;

  await readSSELines(res, (line) => {
    const t = line.trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    sawData = true;

    let ev;
    try { ev = JSON.parse(payload); } catch { return; }

    if (ev.type === 'error') {
      errorMsg = ev.error?.message || JSON.stringify(ev.error).slice(0, 300);
      return;
    }
    if (ev.type === 'message_start') {
      usage.input = ev.message?.usage?.input_tokens || 0;
      return;
    }
    if (ev.type === 'content_block_start') {
      blocks[ev.index] = ev.content_block?.type === 'tool_use'
        ? { type: 'tool_use', id: ev.content_block.id, name: ev.content_block.name, json: '' }
        : { type: 'text' };
      return;
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        text += d.text;
        onDelta?.({ type: 'text', text: d.text, accumulated: text });
      } else if (d.type === 'input_json_delta') {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') b.json += d.partial_json || '';
      }
      return;
    }
    if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
      if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
    }
  });

  if (errorMsg) throw new Error(`Anthropic: ${errorMsg}`);
  if (!sawData) throw new Error('A Anthropic abriu o stream mas não enviou nenhum dado.');

  const toolCalls = blocks
    .filter(b => b?.type === 'tool_use')
    .map(b => ({ id: b.id, name: b.name, args: safeParse(b.json) }));

  if (!stop && !text && !toolCalls.length) {
    throw new Error('A conexão caiu antes de qualquer conteúdo chegar. Tente novamente.');
  }
  return { text, toolCalls, usage, stop: stop || 'incomplete' };
}

// Falhas de borda (proxy cortando, 429, 5xx, rede) costumam passar na segunda
// tentativa; erros de request (4xx de auth/payload) não, então não são repetidos.
const TRANSIENT_RE = /\b(429|500|502|503|504)\b|conexão .*caiu|não enviou nenhum dado|failed to fetch|network|load failed/i;

function isTransient(err) {
  return TRANSIENT_RE.test(err?.message || '');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function callModel({ provider, model, messages, tools, opts = {} }) {
  // Presets como "claude-code" apontam para outro tipo via variantOf.
  const base = getProviderType(provider.type)?.variantOf || provider.type;
  const attempts = opts.retries ?? 2;

  let lastErr;
  for (let i = 0; i <= attempts; i++) {
    try {
      if (base === 'anthropic') return await callAnthropic(provider, model, messages, tools, opts);
      if (base === 'google') return await callGemini(provider, model, messages, tools, opts);
      return await callOpenAILike(provider, model, messages, tools, opts);
    } catch (e) {
      lastErr = e;
      if (i === attempts || !isTransient(e)) throw e;
      opts.onDelta?.({ type: 'retry', attempt: i + 1, of: attempts, message: e.message });
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

export function estimateCost(model, usage) {
  const input = (usage.input / 1e6) * (model.inPer1M || 0);
  const output = (usage.output / 1e6) * (model.outPer1M || 0);
  return input + output;
}

export function resolveEndpoint(provider) {
  if (provider.endpoint) return provider.endpoint;
  const type = getProviderType(provider.type);
  return type?.endpoint || '';
}

export async function fetchModels(endpoint, apiKey, apiType) {
  const results = [];

  if (apiType === 'anthropic') {
    const knownModels = [
      { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', context: 200000, maxOutput: 32000 },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', context: 200000, maxOutput: 8192 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', context: 200000, maxOutput: 8192 },
    ];
    for (const m of knownModels) {
      try {
        const res = await fetch(endpoint || 'https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: m.id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        });
        if (res.ok || res.status === 400) results.push(m);
      } catch {}
    }
    return results;
  }

  if (apiType === 'google') {
    try {
      const base = (endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
      const res = await fetch(`${base}/models?key=${encodeURIComponent(apiKey)}`);
      if (res.ok) {
        const data = await res.json();
        for (const m of (data.models || [])) {
          if (!m.name) continue;
          const id = m.name.replace('models/', '');
          if (!id.startsWith('gemini')) continue;
          results.push({
            id,
            label: m.displayName || id,
            context: m.inputTokenLimit || 128000,
            maxOutput: m.outputTokenLimit || 8000,
          });
        }
      }
    } catch {}
    return results;
  }

  const modelsUrl = gatewayModelsUrl(endpoint);
  const headers = {};
  applyAuthHeader(headers, apiKey, 'bearer');

  try {
    const res = await fetch(modelsUrl, { headers });
    if (res.ok) {
      const data = await res.json();
      const list = data.data || data.models || (Array.isArray(data) ? data : []);
      for (const m of list) {
        const id = m.id || m.name || m.model;
        if (!id) continue;
        results.push({
          id,
          label: m.name || m.id || id,
          context: m.context_length || m.context_window || 128000,
          maxOutput: m.max_output || 8000,
        });
      }
    }
  } catch {}
  return results;
}

// Versão para gateways: lança erro em vez de engolir, e respeita o esquema de auth.
export async function fetchGatewayModels({ endpoint, apiKey, authScheme = 'bearer', extraHeaders }) {
  const modelsUrl = gatewayModelsUrl(endpoint);
  if (!modelsUrl) throw new Error('Informe a URL base do gateway.');

  const headers = { accept: 'application/json' };
  applyAuthHeader(headers, apiKey, authScheme);
  if (extraHeaders) Object.assign(headers, extraHeaders);

  let res;
  try {
    res = await fetch(modelsUrl, { headers });
  } catch (e) {
    throw new Error(`Não foi possível alcançar ${modelsUrl} — ${e.message}. Verifique a URL e se a extensão tem permissão para esse domínio.`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gateway respondeu ${res.status} em ${modelsUrl}: ${raw.slice(0, 300)}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Resposta de ${modelsUrl} não é JSON (o gateway devolveu HTML?). Confira se a URL base está correta.`);
  }

  const list = data.data || data.models || (Array.isArray(data) ? data : []);
  if (!Array.isArray(list) || !list.length) {
    throw new Error('O gateway respondeu, mas não retornou nenhum modelo em /models.');
  }

  const models = [];
  for (const m of list) {
    const id = typeof m === 'string' ? m : (m.id || m.name || m.model);
    if (!id) continue;
    models.push({
      id,
      label: prettyModelLabel(id, typeof m === 'object' ? m : null),
      context: m?.context_length || m?.context_window || m?.max_context_length || 128000,
      maxOutput: m?.max_output || m?.max_output_tokens || 8000,
      ownedBy: typeof m === 'object' ? (m.owned_by || null) : null,
    });
  }
  if (!models.length) throw new Error('Nenhum modelo com "id" reconhecível na resposta do gateway.');
  return models;
}

// Ping barato: /models já valida URL + chave + esquema de auth de uma vez.
export async function testGatewayConnection(cfg) {
  const models = await fetchGatewayModels(cfg);
  return { ok: true, count: models.length, models };
}

function prettyModelLabel(id, meta) {
  if (meta?.display_name) return meta.display_name;
  const slash = id.lastIndexOf('/');
  const tail = slash >= 0 ? id.slice(slash + 1) : id;
  const prefix = slash >= 0 ? id.slice(0, slash) : '';
  const words = tail
    .replace(/[-_]+/g, ' ')
    .replace(/\b([a-z])/g, (s) => s.toUpperCase());
  return prefix ? `${words} (${prefix})` : words;
}
