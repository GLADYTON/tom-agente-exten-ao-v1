// Staging virtual de edições do agente.
// Nenhuma escrita remota acontece enquanto arquivos estão aqui. Commit exige
// aprovação humana explícita e usa digest/base SHA calculados no instante da proposta.

import {
  normalizePath as safeNormalizePath,
  assertTextLimit,
  assertStageLimits,
  LIMITS,
} from './guard.js';

export function normalizePath(path) {
  return safeNormalizePath(path);
}

function lineCount(text) {
  if (!text) return 0;
  const n = String(text).split('\n').length;
  return String(text).endsWith('\n') ? n - 1 : n;
}

// Diff aproximado por multiset de linhas: usado nos badges e na aprovação.
export function diffStats(entry) {
  if (!entry) return { added: 0, removed: 0, kind: 'mod' };
  if (entry.action === 'delete') {
    return { added: 0, removed: lineCount(entry.original || ''), kind: 'del' };
  }
  if (!entry.existed) {
    return { added: lineCount(entry.content || ''), removed: 0, kind: 'add' };
  }

  const counts = new Map();
  for (const line of String(entry.original || '').split('\n')) {
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  let added = 0;
  for (const line of String(entry.content || '').split('\n')) {
    const count = counts.get(line) || 0;
    if (count > 0) counts.set(line, count - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of counts.values()) removed += count;
  return { added, removed, kind: 'mod' };
}

export function changeKindLabel(kind) {
  if (kind === 'add') return 'novo';
  if (kind === 'del') return 'removido';
  return 'editado';
}

function stableEntry(entry) {
  return {
    path: entry.path,
    action: entry.action,
    branch: entry.branch,
    existed: !!entry.existed,
    baseBlobSha: entry.sha || null,
    content: entry.action === 'delete' ? null : String(entry.content ?? ''),
  };
}

async function digestText(value) {
  const text = String(value);
  if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback determinístico para ambientes sem Web Crypto. Não é usado como
  // autenticação; serve apenas para detectar mudança dentro da sessão.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export class Stage {
  constructor(defaultBranch) {
    this.defaultBranch = safeNormalizeBranch(defaultBranch);
    this.files = new Map();
    this.cache = new Map();
    this.commits = [];
  }

  get size() { return this.files.size; }
  get pending() { return [...this.files.values()]; }

  remember(path, { text, sha, existed, branch } = {}) {
    const p = normalizePath(path);
    this.cache.set(p, {
      text: String(text ?? ''),
      sha: sha || undefined,
      existed: !!existed,
      branch: branch || this.defaultBranch,
    });
  }

  known(path) {
    const p = normalizePath(path);
    const staged = this.files.get(p);
    if (staged) {
      if (staged.action === 'delete') return { deleted: true, staged: true };
      return { text: staged.content, sha: staged.sha, existed: true, staged: true };
    }
    const cached = this.cache.get(p);
    return cached ? { ...cached, staged: false } : null;
  }

  stageWrite(path, content, { message, branch, original, existed, sha } = {}) {
    const p = normalizePath(path);
    const text = assertTextLimit(content, `Conteúdo de ${p}`, LIMITS.maxFileBytes);
    const prev = this.files.get(p);
    const baseOriginal = prev ? prev.original : original;
    const baseExisted = prev ? prev.existed : existed;
    const entry = {
      path: p,
      action: 'write',
      content: text,
      original: String(baseOriginal ?? ''),
      existed: !!baseExisted,
      sha: sha || prev?.sha,
      branch: branch || prev?.branch || this.defaultBranch,
      messages: [...(prev?.messages || []), message].filter(Boolean).map(String),
    };
    this.files.set(p, entry);
    assertStageLimits(this.pending);
    return entry;
  }

  stageDelete(path, { message, branch, original, existed, sha } = {}) {
    const p = normalizePath(path);
    const prev = this.files.get(p);
    if (prev && !prev.existed) {
      this.files.delete(p);
      return null;
    }
    const entry = {
      path: p,
      action: 'delete',
      content: '',
      original: String((prev ? prev.original : original) ?? ''),
      existed: prev ? prev.existed : !!existed,
      sha: sha || prev?.sha,
      branch: branch || prev?.branch || this.defaultBranch,
      messages: [...(prev?.messages || []), message].filter(Boolean).map(String),
    };
    this.files.set(p, entry);
    assertStageLimits(this.pending);
    return entry;
  }

  byBranch() {
    const groups = new Map();
    for (const entry of this.files.values()) {
      const branch = entry.branch || this.defaultBranch;
      if (!groups.has(branch)) groups.set(branch, []);
      groups.get(branch).push(entry);
    }
    return groups;
  }

  clear(paths) {
    if (!paths) {
      this.files.clear();
      return;
    }
    for (const path of paths) this.files.delete(normalizePath(path));
  }

  summary() {
    return this.pending.map(entry => ({
      path: entry.path,
      branch: entry.branch,
      ...diffStats(entry),
    }));
  }

  async operationDigest(entries = this.pending, baseShaByBranch = {}) {
    const payload = {
      baseShaByBranch: Object.fromEntries(Object.entries(baseShaByBranch).sort()),
      entries: [...entries].sort((a, b) => a.path.localeCompare(b.path)).map(stableEntry),
    };
    return digestText(JSON.stringify(payload));
  }

  diffPreview(entries = this.pending, maxChars = 30_000) {
    const lines = [];
    for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
      lines.push(`--- ${entry.path}`);
      if (entry.action === 'delete') {
        for (const line of String(entry.original || '').split('\n')) lines.push(`- ${line}`);
        continue;
      }
      if (!entry.existed) {
        for (const line of String(entry.content || '').split('\n')) lines.push(`+ ${line}`);
        continue;
      }
      const before = String(entry.original || '').split('\n');
      const after = String(entry.content || '').split('\n');
      const max = Math.max(before.length, after.length);
      for (let i = 0; i < max; i += 1) {
        if (before[i] === after[i]) lines.push(`  ${before[i] ?? ''}`);
        else {
          if (before[i] !== undefined) lines.push(`- ${before[i]}`);
          if (after[i] !== undefined) lines.push(`+ ${after[i]}`);
        }
      }
    }
    const text = lines.join('\n');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [diff truncado]` : text;
  }
}

function safeNormalizeBranch(branch) {
  const value = String(branch || '').trim();
  return value || 'main';
}

export function buildCommitMessage(entries) {
  const messages = [...new Set(entries.flatMap(e => e.messages || []))].filter(Boolean);
  const files = entries.map(e => `- ${e.path} (${changeKindLabel(diffStats(e).kind)})`);
  if (entries.length === 1 && messages.length === 1) return messages[0];
  const subject = messages[0] || `chore: atualiza ${entries.length} arquivo(s)`;
  const body = [
    ...files,
    '',
    ...(messages.length > 1 ? ['Detalhes:', ...messages.slice(1).map(m => `- ${m}`), ''] : []),
    'Commit aprovado pelo usuário via Agente Tom.',
  ];
  return `${subject}\n\n${body.join('\n')}`;
}
