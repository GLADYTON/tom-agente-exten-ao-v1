import * as gh from '../github.js';
import { getRepo } from '../storage.js';
import { normalizePath, diffStats } from './stage.js';

export const TOOL_DEFS = [
  {
    name: 'list_repo_tree',
    description: 'Lista arquivos e diretórios do repositório ativo. Use antes de editar para saber o que existe. A árvore fica em cache: chamar de novo no mesmo turno é grátis.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Branch ou ref (opcional, padrão: branch ativo).' },
        prefix: { type: 'string', description: 'Filtro por prefixo de caminho (opcional).' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Lê um ou mais arquivos do repositório ativo. Passe VÁRIOS caminhos em "paths" de uma vez — é muito mais rápido que uma chamada por arquivo. Já reflete as edições que você fez neste turno.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho de um arquivo (ex: src/index.js).' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Vários caminhos de uma vez. Prefira esta forma.',
        },
        ref: { type: 'string', description: 'Branch ou ref (opcional).' },
      },
    },
  },
  {
    name: 'edit_file',
    description: 'Substitui um trecho exato de um arquivo. PREFIRA esta ferramenta a write_file para alterar arquivos existentes: você não precisa reescrever o arquivo inteiro, o que é mais rápido e não corre o risco de corromper o resto do código. old_text precisa aparecer exatamente uma vez no arquivo.',
    input_schema: {
      type: 'object',
      required: ['path', 'old_text', 'new_text', 'message'],
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', description: 'Trecho exato a ser substituído, com a indentação original.' },
        new_text: { type: 'string', description: 'Texto que entra no lugar. Use "" para apagar o trecho.' },
        message: { type: 'string', description: 'O que essa mudança faz (entra na mensagem do commit).' },
        branch: { type: 'string', description: 'Branch destino (opcional, padrão: branch ativo).' },
      },
    },
  },
  {
    name: 'write_file',
    description: 'Cria um arquivo novo ou substitui o conteúdo inteiro de um existente. Para alterações pontuais em arquivo que já existe, use edit_file. As mudanças entram numa área de staging e são commitadas juntas ao final do turno.',
    input_schema: {
      type: 'object',
      required: ['path', 'content', 'message'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string', description: 'Conteúdo completo do arquivo (texto UTF-8).' },
        message: { type: 'string', description: 'O que essa mudança faz (entra na mensagem do commit).' },
        branch: { type: 'string', description: 'Branch destino (opcional, padrão: branch ativo).' },
      },
    },
  },
  {
    name: 'delete_file',
    description: 'Remove um arquivo do repositório. Entra no mesmo commit das outras mudanças do turno.',
    input_schema: {
      type: 'object',
      required: ['path', 'message'],
      properties: {
        path: { type: 'string' },
        message: { type: 'string' },
        branch: { type: 'string' },
      },
    },
  },
  {
    name: 'create_branch',
    description: 'Cria uma nova branch a partir de outra (padrão: da branch ativa). Faça isso ANTES de editar se quiser as mudanças fora da branch principal.',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Nome da nova branch.' },
        from: { type: 'string', description: 'Branch de origem (opcional).' },
      },
    },
  },
  {
    name: 'open_pr',
    description: 'Abre um Pull Request de uma branch para a base. As mudanças pendentes são commitadas automaticamente antes do PR.',
    input_schema: {
      type: 'object',
      required: ['head', 'title'],
      properties: {
        head: { type: 'string', description: 'Branch com as mudanças.' },
        base: { type: 'string', description: 'Branch de destino (opcional).' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
];

// Ferramentas que alteram arquivos: usadas para decidir se o turno precisa commit.
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

const MAX_READ_CHARS = 40000;

async function requireRepo() {
  const repo = await getRepo();
  if (!repo) throw new Error('Nenhum repositório ativo. Selecione um em Repos.');
  return repo;
}

// Busca o arquivo respeitando o staging: se o agente já escreveu, ele vê a
// própria versão, não a do repositório.
async function loadFile(ctx, owner, repo, path, ref) {
  const p = normalizePath(path);
  const known = ctx.stage?.known(p);
  if (known) {
    if (known.deleted) return { existed: false, text: '', sha: undefined, staged: true, deleted: true };
    return { existed: known.existed !== false, text: known.text ?? '', sha: known.sha, staged: known.staged };
  }
  try {
    const f = await gh.getFile(owner, repo, p, ref);
    if (f.type === 'dir') return { isDir: true, entries: f.entries };
    const state = { existed: true, text: f.text, sha: f.sha, size: f.size };
    ctx.stage?.remember(p, { text: f.text, sha: f.sha, existed: true });
    return state;
  } catch (e) {
    if (/\b404\b/.test(e.message)) {
      const state = { existed: false, text: '', sha: undefined };
      ctx.stage?.remember(p, state);
      return state;
    }
    throw e;
  }
}

export async function runTool(name, args, ctx = {}) {
  const repo = ctx.repo || await requireRepo();
  const [owner, repoName] = repo.fullName.split('/');
  const branch = repo.branch;
  const stage = ctx.stage;

  if (name === 'list_repo_tree') {
    const ref = args.ref || branch;
    let items;
    if (ctx.treeCache?.has(ref)) {
      items = ctx.treeCache.get(ref);
    } else {
      const tree = await gh.getTree(owner, repoName, ref, true);
      items = tree.tree.map(t => ({ path: t.path, type: t.type, size: t.size }));
      ctx.treeCache?.set(ref, items);
    }

    // Arquivos criados neste turno ainda não estão na árvore remota.
    const staged = stage ? stage.pending : [];
    const stagedPaths = new Set(staged.filter(e => e.action === 'write' && !e.existed).map(e => e.path));
    const deleted = new Set(staged.filter(e => e.action === 'delete').map(e => e.path));
    let all = items
      .filter(i => !deleted.has(i.path))
      .concat([...stagedPaths].map(p => ({ path: p, type: 'blob', pending: true })));

    if (args.prefix) all = all.filter(i => i.path.startsWith(args.prefix));
    const total = all.length;
    if (all.length > 400) {
      all = all.slice(0, 400).concat([{ path: `... (${total - 400} arquivos truncados, use prefix para filtrar)`, type: 'note' }]);
    }
    return { repo: repo.fullName, ref, count: total, items: all };
  }

  if (name === 'read_file') {
    const list = (args.paths?.length ? args.paths : [args.path]).filter(Boolean).map(normalizePath);
    if (!list.length) throw new Error('Informe "path" ou "paths".');
    const ref = args.ref || branch;

    // Paralelo: ler 8 arquivos custa quase o mesmo que ler 1.
    const results = await Promise.all(list.map(async (p) => {
      try {
        const f = await loadFile(ctx, owner, repoName, p, ref);
        if (f.isDir) return { path: p, type: 'dir', entries: f.entries.map(e => e.path) };
        if (!f.existed) return { path: p, error: 'não existe neste ref' };
        const truncated = f.text.length > MAX_READ_CHARS;
        return {
          path: p,
          sha: f.sha,
          pending: f.staged || undefined,
          truncated: truncated || undefined,
          content: truncated ? f.text.slice(0, MAX_READ_CHARS) + '\n... [truncado]' : f.text,
        };
      } catch (e) {
        return { path: p, error: e.message };
      }
    }));

    return list.length === 1 ? results[0] : { files: results };
  }

  if (name === 'edit_file') {
    if (!stage) throw new Error('edit_file indisponível sem área de staging.');
    const p = normalizePath(args.path);
    const target = args.branch || branch;
    const f = await loadFile(ctx, owner, repoName, p, target);
    if (f.isDir) throw new Error(`${p} é um diretório.`);
    if (!f.existed) throw new Error(`${p} não existe. Use write_file para criar.`);

    const oldText = args.old_text ?? '';
    if (!oldText) throw new Error('old_text vazio. Para reescrever o arquivo todo use write_file.');

    const first = f.text.indexOf(oldText);
    if (first === -1) {
      throw new Error(`old_text não encontrado em ${p}. Releia o arquivo com read_file e copie o trecho exatamente, com a indentação original.`);
    }
    if (f.text.indexOf(oldText, first + oldText.length) !== -1) {
      throw new Error(`old_text aparece mais de uma vez em ${p}. Inclua mais linhas de contexto para o trecho ficar único.`);
    }

    const content = f.text.slice(0, first) + (args.new_text ?? '') + f.text.slice(first + oldText.length);
    const entry = stage.stageWrite(p, content, {
      message: args.message,
      branch: target,
      original: f.text,
      existed: true,
      sha: f.sha,
    });
    const stats = diffStats(entry);
    ctx.onFileChange?.({ path: p, branch: target, ...stats, message: args.message });
    return { staged: true, path: p, branch: target, added: stats.added, removed: stats.removed, note: 'Será commitado junto com as outras mudanças ao final do turno.' };
  }

  if (name === 'write_file') {
    if (!stage) throw new Error('write_file indisponível sem área de staging.');
    const p = normalizePath(args.path);
    const target = args.branch || branch;
    const f = await loadFile(ctx, owner, repoName, p, target);
    if (f.isDir) throw new Error(`${p} é um diretório.`);

    const entry = stage.stageWrite(p, args.content ?? '', {
      message: args.message,
      branch: target,
      original: f.text || '',
      existed: !!f.existed,
      sha: f.sha,
    });
    const stats = diffStats(entry);
    ctx.onFileChange?.({ path: p, branch: target, ...stats, message: args.message });
    return { staged: true, path: p, branch: target, added: stats.added, removed: stats.removed, created: !f.existed, note: 'Será commitado junto com as outras mudanças ao final do turno.' };
  }

  if (name === 'delete_file') {
    if (!stage) throw new Error('delete_file indisponível sem área de staging.');
    const p = normalizePath(args.path);
    const target = args.branch || branch;
    const f = await loadFile(ctx, owner, repoName, p, target);
    if (f.isDir) throw new Error(`${p} é um diretório, não um arquivo.`);
    if (!f.existed) throw new Error(`${p} não existe.`);

    // Remoção é a ação mais difícil de desfazer pelo painel: o conteúdo sai do
    // HEAD e o usuário precisaria ir ao histórico do GitHub para recuperar.
    // Arquivo criado neste mesmo turno não conta — descartar isso é inofensivo.
    const createdThisTurn = stage.known(p)?.staged && !stage.files.get(p)?.existed;
    if (ctx.settings?.confirmDelete !== false && ctx.requestApproval && !createdThisTurn) {
      const ok = await ctx.requestApproval({
        kind: 'delete',
        branch: target,
        files: [{ path: p, action: 'delete' }],
        lines: (f.text || '').split('\n').length,
        summary: `apagar ${p} (${target})`,
      });
      if (!ok) {
        return {
          staged: false,
          path: p,
          denied: true,
          note: 'O usuário não autorizou apagar este arquivo. Não tente de novo sem que ele peça; siga com o resto da tarefa.',
        };
      }
    }

    const entry = stage.stageDelete(p, {
      message: args.message,
      branch: target,
      original: f.text || '',
      existed: true,
    });
    if (!entry) {
      ctx.onFileChange?.({ path: p, branch: target, added: 0, removed: 0, kind: 'noop' });
      return { staged: false, path: p, note: 'O arquivo havia sido criado neste turno; a criação foi descartada.' };
    }
    const stats = diffStats(entry);
    ctx.onFileChange?.({ path: p, branch: target, ...stats, message: args.message });
    return { staged: true, path: p, branch: target, removed: stats.removed, note: 'Remoção será aplicada no commit final.' };
  }

  if (name === 'create_branch') {
    const res = await gh.createBranch(owner, repoName, args.name, args.from || branch);
    ctx.treeCache?.delete(args.name);
    return { branch: args.name, ref: res.ref };
  }

  if (name === 'open_pr') {
    // PR sem commit não mostra nada: fecha o staging primeiro.
    const flushed = ctx.flush ? await ctx.flush('open_pr') : [];
    const pr = await gh.openPR(owner, repoName, {
      head: args.head,
      base: args.base || branch,
      title: args.title,
      body: args.body || '',
    });
    return {
      number: pr.number,
      url: pr.html_url,
      committed: flushed.map(c => ({ sha: c.sha?.slice(0, 7), branch: c.branch, files: c.count })),
    };
  }

  throw new Error(`Tool desconhecida: ${name}`);
}
