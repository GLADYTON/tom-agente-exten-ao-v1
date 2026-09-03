// Staging de edições do agente.
//
// Antes: cada write_file = 1 commit = 2 chamadas na API do GitHub (GET sha + PUT).
// 10 arquivos = 20 round trips e 10 commits poluindo o histórico.
// Agora as edições acumulam aqui e o loop fecha tudo em UM commit por branch.
// De quebra o agente relê o que ele mesmo escreveu, em vez de reler a versão
// antiga do repositório e sobrescrever seu próprio trabalho.

export function normalizePath(path) {
  return String(path || '').trim().replace(/^\.?\//, '');
}

function lineCount(text) {
  if (!text) return 0;
  const n = text.split('\n').length;
  // Arquivo terminando em \n não conta a linha vazia final.
  return text.endsWith('\n') ? n - 1 : n;
}

// Diff aproximado por multiset de linhas: barato e suficiente para os badges do
// chat. Não é Myers — linha movida conta como neutra, não como +1/-1.
export function diffStats(entry) {
  if (!entry) return { added: 0, removed: 0, kind: 'mod' };

  if (entry.action === 'delete') {
    return { added: 0, removed: lineCount(entry.original || ''), kind: 'del' };
  }
  if (!entry.existed) {
    return { added: lineCount(entry.content || ''), removed: 0, kind: 'add' };
  }

  const counts = new Map();
  for (const l of String(entry.original || '').split('\n')) {
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  let added = 0;
  for (const l of String(entry.content || '').split('\n')) {
    const c = counts.get(l) || 0;
    if (c > 0) counts.set(l, c - 1);
    else added++;
  }
  let removed = 0;
  for (const c of counts.values()) removed += c;

  return { added, removed, kind: 'mod' };
}

export function changeKindLabel(kind) {
  if (kind === 'add') return 'novo';
  if (kind === 'del') return 'removido';
  return 'editado';
}

export class Stage {
  constructor(defaultBranch) {
    this.defaultBranch = defaultBranch;
    this.files = new Map();   // path -> entry pendente de commit
    this.cache = new Map();   // path -> estado conhecido do repo (evita refetch)
    this.commits = [];        // commits já efetivados nesta execução
  }

  get size() {
    return this.files.size;
  }

  get pending() {
    return [...this.files.values()];
  }

  // Registra o que foi lido do repo para não buscar o mesmo arquivo duas vezes.
  remember(path, { text, sha, existed }) {
    this.cache.set(normalizePath(path), { text, sha, existed });
  }

  // Conteúdo atual da perspectiva do agente: staged > cache > desconhecido.
  known(path) {
    const p = normalizePath(path);
    const staged = this.files.get(p);
    if (staged) {
      if (staged.action === 'delete') return { deleted: true, staged: true };
      return { text: staged.content, sha: staged.sha, existed: true, staged: true };
    }
    const cached = this.cache.get(p);
    if (cached) return { ...cached, staged: false };
    return null;
  }

  stageWrite(path, content, { message, branch, original, existed, sha }) {
    const p = normalizePath(path);
    const prev = this.files.get(p);

    // Segunda escrita no mesmo arquivo: o original continua sendo o do repo,
    // senão o diff mostraria só a diferença entre as duas versões do agente.
    const baseOriginal = prev ? prev.original : original;
    const baseExisted = prev ? prev.existed : existed;

    const entry = {
      path: p,
      action: 'write',
      content,
      original: baseOriginal ?? '',
      existed: !!baseExisted,
      sha: sha ?? prev?.sha,
      branch: branch || this.defaultBranch,
      messages: [...(prev?.messages || []), message].filter(Boolean),
    };
    this.files.set(p, entry);
    return entry;
  }

  stageDelete(path, { message, branch, original, existed }) {
    const p = normalizePath(path);
    const prev = this.files.get(p);

    // Criado e removido na mesma execução: nunca existiu no repo, é no-op.
    if (prev && !prev.existed) {
      this.files.delete(p);
      return null;
    }

    const entry = {
      path: p,
      action: 'delete',
      content: '',
      original: (prev ? prev.original : original) ?? '',
      existed: prev ? prev.existed : !!existed,
      branch: branch || this.defaultBranch,
      messages: [...(prev?.messages || []), message].filter(Boolean),
    };
    this.files.set(p, entry);
    return entry;
  }

  // Caminhos agrupados por branch: um commit por branch tocada.
  byBranch() {
    const groups = new Map();
    for (const entry of this.files.values()) {
      const b = entry.branch || this.defaultBranch;
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(entry);
    }
    return groups;
  }

  clear(paths) {
    if (!paths) { this.files.clear(); return; }
    for (const p of paths) this.files.delete(normalizePath(p));
  }

  summary() {
    return this.pending.map(e => {
      const stats = diffStats(e);
      return { path: e.path, branch: e.branch, ...stats };
    });
  }
}

// Mensagem de commit única a partir das mensagens que o agente deu por arquivo.
export function buildCommitMessage(entries) {
  const msgs = [...new Set(entries.flatMap(e => e.messages || []))].filter(Boolean);
  const files = entries.map(e => {
    const stats = diffStats(e);
    const mark = stats.kind === 'add' ? 'novo' : stats.kind === 'del' ? 'removido' : 'editado';
    return `- ${e.path} (${mark})`;
  });

  if (entries.length === 1 && msgs.length === 1) return msgs[0];

  const subject = msgs[0] || `chore: atualiza ${entries.length} arquivo(s)`;
  const body = [
    ...files,
    '',
    ...(msgs.length > 1 ? ['Detalhes:', ...msgs.slice(1).map(m => `- ${m}`), ''] : []),
    'Commit automático do Agente Tom.',
  ];
  return `${subject}\n\n${body.join('\n')}`;
}
