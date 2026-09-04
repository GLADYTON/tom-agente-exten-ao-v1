import { callModel, estimateCost, isQuotaError } from '../providers/client.js';
import { TOOL_DEFS, WRITE_TOOLS, runTool } from './tools.js';
import { Stage, buildCommitMessage } from './stage.js';
import { isProtectedBranch, describeCommitRequest } from './guard.js';
import * as gh from '../github.js';
import { addUsage, getSettings, getRepo, getBudget, getUsage, getProviders } from '../storage.js';

const DEFAULT_SYSTEM = `Você é um engenheiro de software autônomo que edita repositórios do GitHub do usuário.

Como trabalhar rápido e com precisão:
- Antes de editar, use list_repo_tree e read_file para entender o código atual. Nunca invente caminhos.
- Leia VÁRIOS arquivos numa só chamada de read_file usando "paths". Uma chamada com 6 caminhos é muito mais rápida que 6 chamadas.
- Para alterar arquivo existente, use edit_file (substitui um trecho exato). Só use write_file para criar arquivo novo ou quando o arquivo todo muda.
- Faça mudanças mínimas e cirúrgicas. Mantenha o estilo, nomes e convenções do código ao redor.
- Suas edições vão para uma área de staging e são commitadas automaticamente em UM commit ao final. Não precisa pedir permissão para commitar.
- Dê em "message" uma frase curta dizendo o que aquela mudança faz; ela entra no commit.
- Para tarefas grandes, crie uma branch com create_branch antes de editar e abra um PR com open_pr no final.
- Ao terminar, explique em 1-3 frases o que mudou e por quê.`;

const REVIEW_SYSTEM = `Você é um revisor de código sênior. Você acabou de aplicar mudanças em um repositório.
Revise APENAS o que foi alterado e responda em português com dois blocos curtos:

**Melhorias** — até 3 itens objetivos e acionáveis sobre o código que você mudou (correção, legibilidade, performance, casos de borda não tratados).
**Segurança** — até 3 riscos concretos introduzidos ou tocados pela mudança (validação de entrada, segredos, autenticação, injeção, permissões, dados sensíveis em log). Se não houver risco real, escreva "Nada relevante nesta mudança." e não invente.

Regras: seja específico, cite o arquivo. Sem elogios, sem repetir o que a mudança faz, sem sugerir reescrever tudo. Se algo é grave, diga primeiro.`;

async function monthSpent() {
  const usage = await getUsage();
  const key = new Date().toISOString().slice(0, 7);
  const m = usage[key] || {};
  return Object.values(m).reduce((a, r) => a + (r.cost || 0), 0);
}

function filterTools(agent) {
  if (!agent?.tools?.length) return TOOL_DEFS;
  // edit_file é novo: agentes salvos antes dele têm write_file na lista mas não
  // edit_file, e ficariam sem a ferramenta rápida. Libera junto.
  const allowed = new Set(agent.tools);
  if (allowed.has('write_file')) allowed.add('edit_file');
  return TOOL_DEFS.filter(t => allowed.has(t.name));
}

export async function runAgent({ provider, model, agent, userMessage, history, onEvent, onApproval }) {
  const settings = await getSettings();
  const budget = await getBudget();
  const repo = await getRepo();

  const autoCommit = settings.autoCommit !== false;
  const autoReview = settings.autoReview !== false;

  const systemBase = agent?.systemPrompt || settings.systemPrompt || DEFAULT_SYSTEM;
  const system = [
    systemBase,
    repo
      ? `\nRepositório ativo: ${repo.fullName} (branch: ${repo.branch}).`
      : '\nNenhum repositório ativo. Peça ao usuário para selecionar um em Repos.',
    autoCommit
      ? '\nAs edições são commitadas automaticamente em um único commit ao final do turno.'
      : '\nO commit automático está desligado: avise o usuário que as mudanças ficaram pendentes.',
  ].join('');

  const tools = filterTools(agent);
  const messages = [{ role: 'system', content: system }, ...history, { role: 'user', content: userMessage }];
  const maxIter = settings.maxIterations || 12;
  const temperature = agent?.temperature ?? 0.2;
  let totalIn = 0, totalOut = 0, totalCost = 0;

  const stage = repo ? new Stage(repo.branch) : null;
  const commits = [];
  const ctx = {
    repo,
    stage,
    treeCache: new Map(),
    settings,
    onFileChange: (info) => onEvent?.({ type: 'file_change', ...info }),
    flush: (reason) => flushStage(reason),
    // Usado por delete_file: remoção é a ação mais cara de desfazer pelo painel.
    requestApproval: typeof onApproval === 'function' ? onApproval : null,
  };

  function track(usage, cost) {
    totalIn += usage.input || 0;
    totalOut += usage.output || 0;
    totalCost += cost;
  }

  // Repassa o streaming do provider para a UI: o texto aparece conforme chega em
  // vez de só no fim, e a retentativa por falha de borda fica visível.
  function relayDelta(d) {
    if (d.type === 'text') onEvent?.({ type: 'assistant_text', text: d.accumulated });
    else if (d.type === 'retry') {
      onEvent?.({ type: 'retry', message: d.message, attempt: d.attempt, of: d.of });
    }
  }

  // Fecha o staging: um commit por branch tocada.
  async function flushStage(reason) {
    if (!stage || !stage.size) return [];
    const [owner, repoName] = repo.fullName.split('/');
    const groups = stage.byBranch();
    const done = [];

    for (const [branch, entries] of groups) {
      const files = entries.map(e => e.action === 'delete'
        ? { path: e.path, action: 'delete' }
        : { path: e.path, content: e.content });

      // Portão de branch protegida: nada é escrito sem "ok" do usuário. O
      // agente não consegue rodar build/teste no browser, então essa é a única
      // barreira antes de código não verificado entrar em main.
      if (settings.confirmProtectedCommit !== false
          && isProtectedBranch(branch, settings.protectedBranches)
          && typeof onApproval === 'function') {
        const ok = await onApproval({
          kind: 'commit',
          branch,
          reason,
          files: entries.map(e => ({ path: e.path, action: e.action })),
          summary: describeCommitRequest({ branch, files: entries }),
        });
        if (!ok) {
          // Staging preservado: o usuário pode redirecionar para outra branch
          // ou aprovar depois com "commita agora".
          onEvent?.({
            type: 'commit_denied',
            branch,
            count: files.length,
            files: entries.map(e => e.path),
          });
          continue;
        }
      }

      onEvent?.({ type: 'commit_start', branch, count: files.length, reason });

      try {
        const res = await gh.createCommit(owner, repoName, branch, files, buildCommitMessage(entries));
        stage.clear(entries.map(e => e.path));
        stage.commits.push(res);
        // Próxima leitura desta branch precisa ver a árvore nova.
        ctx.treeCache.delete(branch);
        // O que foi commitado passa a ser o estado base do repositório.
        for (const e of entries) {
          if (e.action === 'delete') stage.cache.delete(e.path);
          else stage.remember(e.path, { text: e.content, sha: undefined, existed: true });
        }
        done.push(res);
        commits.push(res);
        onEvent?.({
          type: 'commit_done',
          sha: res.sha, url: res.url, branch, count: files.length,
          files: entries.map(e => e.path),
        });
      } catch (e) {
        // Staging preservado: o usuário pode mandar "tenta commitar de novo".
        onEvent?.({ type: 'commit_error', branch, error: e.message, count: files.length });
        throw e;
      }
    }
    return done;
  }

  let stopReason = 'done';

  for (let i = 0; i < maxIter; i++) {
    if (budget.monthlyUSD > 0) {
      const spent = await monthSpent();
      if (spent >= budget.monthlyUSD) {
        onEvent?.({ type: 'error', message: `Orçamento mensal atingido (US$ ${spent.toFixed(4)} / US$ ${budget.monthlyUSD}).` });
        stopReason = 'budget';
        break;
      }
    }

    onEvent?.({ type: 'thinking', iter: i });

    let result;
    let currentProvider = provider;
    let currentModel = model;
    
    try {
      result = await callModel({
        provider: currentProvider, model: currentModel, messages, tools,
        opts: { temperature, onDelta: relayDelta },
      });
    } catch (e) {
      // Se for erro de cota e o fallback automático estiver ligado, tenta a fila.
      if (isQuotaError(e) && settings.autoFallback && settings.fallbackQueue?.length) {
        onEvent?.({ type: 'retry', message: `Limite atingido em ${currentModel.label || currentModel.id}. Tentando fallback automático...`, attempt: 1, of: 1 });
        
        const allProviders = await getProviders();
        let fallbackSuccess = false;
        
        for (const fallbackRef of settings.fallbackQueue) {
          const [pId, mId] = fallbackRef.split('::');
          const fbProvider = allProviders.find(p => p.id === pId);
          const fbModel = fbProvider?.models?.find(m => m.id === mId);
          
          if (!fbProvider || !fbModel) continue;
          // Não tenta o mesmo modelo que acabou de falhar
          if (fbProvider.id === currentProvider.id && fbModel.id === currentModel.id) continue;
          
          onEvent?.({ type: 'retry', message: `Fallback: tentando ${fbModel.label || fbModel.id}...`, attempt: 1, of: 1 });
          
          try {
            result = await callModel({
              provider: fbProvider, model: fbModel, messages, tools,
              opts: { temperature, onDelta: relayDelta },
            });
            currentProvider = fbProvider;
            currentModel = fbModel;
            fallbackSuccess = true;
            break; // Deu certo, sai do loop de fallback
          } catch (fbErr) {
            // Se o fallback também der erro de cota, tenta o próximo da fila.
            if (isQuotaError(fbErr)) continue;
            // Se for outro erro (ex: auth), aborta.
            throw fbErr;
          }
        }
        
        if (!fallbackSuccess) {
          onEvent?.({ type: 'error', message: `Todos os modelos de fallback falharam por limite de cota. Último erro: ${e.message}` });
          stopReason = 'error';
          break;
        }
      } else {
        onEvent?.({ type: 'error', message: e.message });
        stopReason = 'error';
        break;
      }
    }

    const cost = estimateCost(currentModel, result.usage);
    track(result.usage, cost);
    await addUsage(currentProvider.id, currentModel.id, result.usage.input, result.usage.output, cost);
    onEvent?.({ type: 'usage', usage: result.usage, cost });

    if (result.text) onEvent?.({ type: 'assistant_text', text: result.text });

    if (!result.toolCalls?.length) {
      messages.push({ role: 'assistant', content: result.text });
      break;
    }

    messages.push({ role: 'assistant', content: result.text || '', tool_calls: result.toolCalls });

    // Leituras independentes rodam juntas; escritas mexem no staging e vão em
    // ordem para o resultado ser determinístico.
    const reads = result.toolCalls.filter(tc => !WRITE_TOOLS.has(tc.name));
    const writes = result.toolCalls.filter(tc => WRITE_TOOLS.has(tc.name));

    const outputs = new Map();

    async function exec(tc) {
      onEvent?.({ type: 'tool_call', name: tc.name, args: tc.args });
      try {
        const out = await runTool(tc.name, tc.args || {}, ctx);
        outputs.set(tc.id, out);
        onEvent?.({ type: 'tool_result', name: tc.name, result: out });
      } catch (e) {
        outputs.set(tc.id, { error: e.message });
        onEvent?.({ type: 'tool_error', name: tc.name, error: e.message });
      }
    }

    await Promise.all(reads.map(exec));
    for (const tc of writes) await exec(tc);

    // Ordem original preservada nas mensagens: alguns providers exigem que cada
    // tool_call tenha seu tool_result na sequência em que foram pedidos.
    for (const tc of result.toolCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        tool_name: tc.name,
        content: JSON.stringify(outputs.get(tc.id) ?? { error: 'sem resultado' }).slice(0, 40000),
      });
    }

    if (i === maxIter - 1) stopReason = 'max_iterations';
  }

  // --- Commit automático do que sobrou no staging.
  if (stage?.size) {
    if (autoCommit && stopReason !== 'error' && stopReason !== 'budget') {
      try {
        await flushStage('fim do turno');
      } catch {
        // commit_error já foi emitido; não derruba o turno.
      }
    } else if (stage.size) {
      onEvent?.({
        type: 'commit_skipped',
        count: stage.size,
        files: stage.pending.map(e => e.path),
        reason: autoCommit ? stopReason : 'desligado nas configurações',
      });
    }
  }

  // --- Revisão pós-execução: melhorias + segurança sobre o que mudou.
  if (autoReview && commits.length) {
    const changed = commits.flatMap(c => c.files || []);
    const touched = [...new Set(changed.length ? changed : stage?.commits.flatMap(c => c.files || []) || [])];
    onEvent?.({ type: 'review_start' });
    try {
      const reviewMessages = [
        { role: 'system', content: REVIEW_SYSTEM },
        ...messages.filter(m => m.role !== 'system'),
        {
          role: 'user',
          content: `As mudanças acima foram commitadas em ${repo.fullName}`
            + `${touched.length ? ` (${touched.join(', ')})` : ''}.`
            + ' Agora produza a revisão de Melhorias e Segurança conforme as instruções.',
        },
      ];
      const rev = await callModel({ provider, model, messages: reviewMessages, tools: [], opts: { temperature: 0.1 } });
      const revCost = estimateCost(model, rev.usage);
      track(rev.usage, revCost);
      await addUsage(provider.id, model.id, rev.usage.input, rev.usage.output, revCost);
      onEvent?.({ type: 'usage', usage: rev.usage, cost: revCost });
      if (rev.text) onEvent?.({ type: 'review', text: rev.text });
      else onEvent?.({ type: 'review_error', message: 'O modelo não retornou a revisão.' });
    } catch (e) {
      onEvent?.({ type: 'review_error', message: e.message });
    }
  }

  return { messages, totalIn, totalOut, totalCost, commits, stopReason };
}
