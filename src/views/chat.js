import { el, clear, renderInlineMd, fmtCost, fmtTokens } from '../util/dom.js';
import { getProviders, getActiveModel, getRepo, getChats, saveChats, getActiveAgent } from '../storage.js';
import { runAgent } from '../agent/loop.js';

let history = [];

function bubble(role, contentNode) {
  return el('div', { class: `msg ${role}` }, [
    el('div', { class: 'role' }, role === 'user' ? 'você' : role),
    contentNode,
  ]);
}

function fmtArgs(a) {
  try { return JSON.stringify(a, null, 2); } catch { return String(a); }
}

function lookup(providers, ref) {
  if (!ref) return null;
  const p = providers.find(pp => pp.id === ref.providerId);
  const m = p?.models?.find(mm => mm.id === ref.modelId);
  return p && m ? { provider: p, model: m } : null;
}

// Modelo do agente tem prioridade; se o provider dele foi removido, cai no global.
function resolveModel(providers, agent, globalActive) {
  return lookup(providers, agent?.modelRef)
    || lookup(providers, globalActive)
    || { provider: null, model: null };
}

function openAgents() {
  if (window._openAgentsPanel) window._openAgentsPanel();
}

// Header fixo do chat: identidade do agente + botão que abre o painel de agentes.
function chatHeader(agent) {
  return el('div', { class: 'chat-top-header' }, [
    el('div', { class: 'chat-agent-info', title: 'Gerenciar agentes', onclick: openAgents }, [
      el('span', { class: 'chat-agent-emoji' }, agent?.emoji || '🤖'),
      el('span', { class: 'chat-agent-name' }, agent?.name || 'Sem agente'),
      el('span', { class: 'chat-agent-badge' }, 'ativo'),
    ]),
    el('div', { class: 'chat-header-actions' }, [
      el('button', { class: 'btn-agents-toggle', onclick: openAgents }, [
        el('span', {}, '🤖'),
        el('span', {}, 'Agentes'),
      ]),
    ]),
  ]);
}

// Pedido de aprovação humana: renderiza um card com Aprovar / Recusar e resolve
// a Promise no clique. O loop do agente fica bloqueado esperando essa resposta,
// então o botão é a única saída — sem timeout, para não commitar por descuido.
function askApproval(msgsBox, req) {
  return new Promise((resolve) => {
    const isDelete = req.kind === 'delete';

    const fileList = el('ul', { class: 'approval-files' },
      (req.files || []).map(f => el('li', {}, `${f.action === 'delete' ? '🗑' : '±'} ${f.path}`)));

    const approveBtn = el('button', { class: 'btn btn-primary btn-sm' },
      isDelete ? 'Apagar' : 'Aprovar e commitar');
    const denyBtn = el('button', { class: 'btn btn-ghost-danger btn-sm' }, 'Recusar');

    const card = el('div', { class: 'msg tool approval' }, [
      el('div', { class: 'role' }, isDelete ? '⚠ confirmar remoção' : '⚠ branch protegida'),
      el('div', { class: 'approval-body' }, [
        el('p', {}, isDelete
          ? `O agente quer apagar um arquivo de ${req.branch}. Isso sai do HEAD e só volta pelo histórico do GitHub.`
          : `O agente quer commitar ${req.summary}. Nada foi verificado por build ou teste.`),
        fileList,
      ]),
      el('div', { class: 'approval-actions' }, [denyBtn, approveBtn]),
    ]);

    function settle(ok) {
      approveBtn.disabled = true;
      denyBtn.disabled = true;
      card.classList.add(ok ? 'approved' : 'denied');
      card.querySelector('.approval-actions').replaceChildren(
        el('span', { class: 'field-hint' }, ok ? '✓ aprovado' : '✗ recusado'),
      );
      resolve(ok);
    }

    approveBtn.addEventListener('click', () => settle(true));
    denyBtn.addEventListener('click', () => settle(false));

    msgsBox.appendChild(card);
    msgsBox.scrollTop = msgsBox.scrollHeight;
  });
}

function emptyView(icon, title, text) {
  return el('div', { class: 'empty-card' }, [
    el('div', { class: 'empty-icon-wrap' }, icon),
    el('h3', { class: 'empty-title' }, title),
    el('p', { class: 'empty-text' }, text),
  ]);
}

export async function renderChat(view) {
  clear(view);

  const [providers, globalActive, repo, agent] = await Promise.all([
    getProviders(), getActiveModel(), getRepo(), getActiveAgent(),
  ]);

  const shell = el('div', { class: 'chat-shell-v2' });
  shell.appendChild(chatHeader(agent));
  view.appendChild(shell);

  // Estados de bloqueio: sem provider ou sem modelo resolvido.
  if (!providers.length) {
    const box = el('div', { class: 'chat-messages-scroll' });
    box.appendChild(emptyView('🔌', 'Nenhum modelo configurado',
      'Vá na aba Modelos e adicione um provider de IA. Vários funcionam de graça.'));
    shell.appendChild(box);
    return;
  }

  const { provider, model } = resolveModel(providers, agent, globalActive);
  if (!model) {
    const box = el('div', { class: 'chat-messages-scroll' });
    box.appendChild(emptyView('🎯', 'Escolha um modelo',
      'Defina o modelo padrão na aba Modelos, ou dê um modelo próprio a este agente em Agentes.'));
    shell.appendChild(box);
    return;
  }

  // Barra de contexto: modelo, repo e contadores da sessão.
  const pillsBar = el('div', { class: 'chat-pills-bar' });
  pillsBar.appendChild(el('span', { class: 'pill accent' }, `${provider.name || provider.type} · ${model.label || model.id}`));
  pillsBar.appendChild(repo
    ? el('span', { class: 'pill' }, `${repo.fullName} @ ${repo.branch}`)
    : el('span', { class: 'pill warn' }, 'nenhum repo selecionado'));
  const tokPill = el('span', { class: 'pill' }, '0 tk');
  const costPill = el('span', { class: 'pill' }, '$0.0000');
  pillsBar.appendChild(tokPill);
  pillsBar.appendChild(costPill);
  shell.appendChild(pillsBar);

  const msgsBox = el('div', { class: 'chat-messages-scroll' });
  shell.appendChild(msgsBox);

  const priorChats = await getChats();
  history = priorChats[0]?.messages || [];

  if (!history.length) {
    msgsBox.appendChild(el('div', { class: 'welcome-box' }, [
      el('div', { class: 'welcome-avatar' }, agent?.emoji || '🤖'),
      el('div', { class: 'welcome-title' }, `Olá, sou o ${agent?.name || 'agente'}`),
      el('div', { class: 'welcome-desc' }, agent?.description || 'Descreva o que você quer fazer no seu repositório.'),
    ]));
  }

  history.forEach(m => {
    if (m.role === 'system' || m.role === 'tool') return;
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) return;
    msgsBox.appendChild(bubble(m.role, el('div', { html: renderInlineMd(m.content || '') })));
  });

  // Área de input.
  const input = el('textarea', {
    class: 'chat-textarea',
    rows: '2',
    placeholder: `Diga ao ${agent?.name || 'agente'} o que fazer...`,
  });

  const sendBtn = el('button', { class: 'btn btn-primary btn-sm' }, 'Enviar');
  const clearBtn = el('button', { class: 'btn btn-ghost btn-sm', title: 'Limpar histórico' }, 'Limpar');

  const inputArea = el('div', { class: 'chat-input-area' }, [
    el('div', { class: 'chat-textarea-box' }, [input]),
    el('div', { class: 'chat-bottom-actions' }, [
      el('span', { class: 'kbd-hint' }, 'Ctrl+Enter envia'),
      el('div', { class: 'chat-header-actions' }, [clearBtn, sendBtn]),
    ]),
  ]);
  shell.appendChild(inputArea);

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Limpar o histórico desta conversa?')) return;
    history = [];
    await saveChats([{ messages: [] }]);
    renderChat(view);
  });

  let totalCost = 0, totalTk = 0;

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendBtn.disabled = true;

    msgsBox.querySelector('.welcome-box')?.remove();
    msgsBox.appendChild(bubble('user', el('div', { html: renderInlineMd(text) })));
    msgsBox.scrollTop = msgsBox.scrollHeight;

    const thinkingHtml = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    const assistantNode = el('div', { class: 'thinking', html: thinkingHtml });
    msgsBox.appendChild(bubble('assistant', assistantNode));

    try {
      const out = await runAgent({
        provider, model, agent,
        userMessage: text,
        history,
        onApproval: (req) => askApproval(msgsBox, req),
        onEvent: (ev) => {
          if (ev.type === 'thinking') {
            assistantNode.className = 'thinking';
            assistantNode.innerHTML = thinkingHtml;
          } else if (ev.type === 'assistant_text' && ev.text) {
            assistantNode.className = '';
            assistantNode.innerHTML = renderInlineMd(ev.text);
          } else if (ev.type === 'tool_call') {
            msgsBox.appendChild(el('div', { class: 'msg tool' }, [
              el('div', { class: 'role' }, `→ ${ev.name}`),
              el('pre', {}, fmtArgs(ev.args)),
            ]));
          } else if (ev.type === 'tool_result') {
            msgsBox.appendChild(el('div', { class: 'msg tool ok' }, [
              el('div', { class: 'role' }, `✓ ${ev.name}`),
              el('pre', {}, fmtArgs(ev.result).slice(0, 2000)),
            ]));
          } else if (ev.type === 'tool_error') {
            msgsBox.appendChild(el('div', { class: 'msg tool err' }, [
              el('div', { class: 'role' }, `✗ ${ev.name}`),
              el('div', { class: 'error-banner-inline' }, ev.error),
            ]));
          } else if (ev.type === 'usage') {
            totalTk += (ev.usage.input || 0) + (ev.usage.output || 0);
            totalCost += ev.cost || 0;
            tokPill.textContent = fmtTokens(totalTk) + ' tk';
            costPill.textContent = fmtCost(totalCost);
          } else if (ev.type === 'error') {
            assistantNode.className = '';
            assistantNode.appendChild(el('div', { class: 'error-banner-inline' }, ev.message));
          }
          msgsBox.scrollTop = msgsBox.scrollHeight;
        },
      });
      history = out.messages.filter(mm => mm.role !== 'system');
      await saveChats([{ messages: history }]);
    } catch (e) {
      assistantNode.className = '';
      clear(assistantNode);
      assistantNode.appendChild(el('div', { class: 'error-banner-inline' }, e.message));
    } finally {
      sendBtn.disabled = false;
      msgsBox.scrollTop = msgsBox.scrollHeight;
    }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  msgsBox.scrollTop = msgsBox.scrollHeight;
}
