import { el, clear, renderInlineMd, fmtCost, fmtTokens } from '../util/dom.js';
import {
  getProviders, getActiveModel, getRepo, getChats, saveChats, getActiveAgent,
  getSettings, setSettings, getActiveChatId, setActiveChatId,
} from '../storage.js';
import { runAgent } from '../agent/loop.js';
import { resolveModel } from '../agent/model.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { EV } from '../agent/events.js';
import { createRunView } from './runview.js';
import { AgentRunner } from '../runner.js';

let history = [];
let currentChatId = null;

function bubble(role, contentNode) {
  return el('div', { class: `msg ${role}` }, [
    el('div', { class: 'role' }, role === 'user' ? 'você' : role),
    contentNode,
  ]);
}

function fmtArgs(a) {
  try { return JSON.stringify(a, null, 2); } catch { return String(a); }
}

function openAgents() {
  if (window._openAgentsPanel) window._openAgentsPanel();
}

// Alterna entre agente único e equipe. Persiste na hora: o usuário não deveria
// precisar ir em Config para escolher como quer trabalhar.
function modeToggle(teamMode, onChange) {
  const soloBtn = el('button', { class: teamMode ? '' : 'active', title: 'Um agente executa o pedido inteiro' }, '👤 Solo');
  const teamBtn = el('button', { class: teamMode ? 'active' : '', title: 'Orquestrador divide o pedido entre agentes especialistas' }, '👥 Equipe');
  soloBtn.addEventListener('click', () => onChange(false));
  teamBtn.addEventListener('click', () => onChange(true));
  return el('div', { class: 'mode-toggle' }, [soloBtn, teamBtn]);
}

// Header fixo do chat: identidade do agente + modo + botão do painel de agentes.
function chatHeader(agent, teamMode, onModeChange) {
  return el('div', { class: 'chat-top-header' }, [
    teamMode
      ? el('div', { class: 'chat-agent-info', title: 'Gerenciar agentes', onclick: openAgents }, [
          el('span', { class: 'chat-agent-name' }, agent?.name || 'Agente'),
          el('span', { class: 'chat-agent-mode' }, 'Equipe'),
        ])
      : el('div', { class: 'chat-agent-info' }, [
          el('span', { class: 'chat-agent-name' }, agent?.name || 'Agente'),
          el('span', { class: 'chat-agent-mode' }, 'Solo'),
        ]),
    modeToggle(teamMode, onModeChange),
  ]);
}
  return el('div', { class: 'chat-top-header' }, [
    teamMode
      ? el('div', { class: 'chat-agent-info', title: 'Gerenciar agentes', onclick: openAgents }, [
        el('span', { class: 'chat-agent-emoji' }, '👥'),
        el('span', { class: 'chat-agent-name' }, 'Equipe'),
        el('span', { class: 'chat-agent-badge' }, '3 agentes'),
      ])
      : el('div', { class: 'chat-agent-info', title: 'Gerenciar agentes', onclick: openAgents }, [
        el('span', { class: 'chat-agent-emoji' }, agent?.emoji || '🤖'),
        el('span', { class: 'chat-agent-name' }, agent?.name || 'Sem agente'),
        el('span', { class: 'chat-agent-badge' }, 'ativo'),
      ]),
    el('div', { class: 'chat-header-actions' }, [
      modeToggle(teamMode, onModeChange),
      el('button', { class: 'btn-agents-toggle', onclick: openAgents }, [
        el('span', {}, '🤖'),
        el('span', {}, 'Agentes'),
      ]),
    ]),
  ]);
}

function askApproval(msgsBox, req, resolvePromise) {
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
    resolvePromise(ok);
  }

  approveBtn.addEventListener('click', () => settle(true));
  denyBtn.addEventListener('click', () => settle(false));

  msgsBox.appendChild(card);
  msgsBox.scrollTop = msgsBox.scrollHeight;
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

  const [providers, globalActive, repo, agent, settings] = await Promise.all([
    getProviders(), getActiveModel(), getRepo(), getActiveAgent(), getSettings(),
  ]);

  const teamMode = settings.teamMode === true;

  async function changeMode(next) {
    if (next === teamMode) return;
    await setSettings({ teamMode: next });
    renderChat(view);
  }

  const shell = el('div', { class: 'chat-shell-v2' });
  shell.appendChild(chatHeader(agent, teamMode, changeMode));
  view.appendChild(shell);

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

  const allChats = await getChats();
  currentChatId = await getActiveChatId();
  
  let activeChat = null;
  if (currentChatId) {
    activeChat = allChats.find(c => c.id === currentChatId);
  }
  
  if (!activeChat) {
    currentChatId = `chat_${Date.now()}`;
    activeChat = { id: currentChatId, title: 'Nova Conversa', updatedAt: new Date().toISOString(), messages: [] };
    await setActiveChatId(currentChatId);
  }

  history = activeChat.messages || [];

  if (!history.length && !AgentRunner.isRunning) {
    msgsBox.appendChild(teamMode
      ? el('div', { class: 'welcome-box' }, [
        el('div', { class: 'welcome-avatar' }, '👥'),
        el('div', { class: 'welcome-title' }, 'Modo equipe'),
        el('div', { class: 'welcome-desc' },
          'Descreva o que você quer. O orquestrador divide entre 🎨 Frontend, ⚙️ Backend e 🧪 Code Reviewer. As mudanças ficam em staging até você aprovar o commit.'),
      ])
      : el('div', { class: 'welcome-box' }, [
        el('div', { class: 'welcome-avatar' }, agent?.emoji || '🤖'),
        el('div', { class: 'welcome-title' }, `Olá, sou o ${agent?.name || 'agente'}`),
        el('div', { class: 'welcome-desc' }, agent?.description || 'Descreva o que você quer fazer no seu repositório.'),
      ]));
  }
  }

  history.forEach(m => {
    if (m.role === 'system' || m.role === 'tool') return;
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) return;
    msgsBox.appendChild(bubble(m.role, el('div', { html: renderInlineMd(m.content || '') })));
  });

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

  async function saveCurrentChat() {
    const chats = await getChats();
    const idx = chats.findIndex(c => c.id === currentChatId);
    
    const chatObj = {
      id: currentChatId,
      title: history.find(m => m.role === 'user')?.content?.slice(0, 40) || 'Nova Conversa',
      updatedAt: new Date().toISOString(),
      messages: history
    };

    if (idx >= 0) {
      chats[idx] = chatObj;
    } else {
      chats.unshift(chatObj);
    }
    await saveChats(chats);
  }

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Limpar o histórico desta conversa?')) return;
    history = [];
    await saveCurrentChat();
    renderChat(view);
  });

  let totalCost = 0, totalTk = 0;
  let assistantNode = null;
  let currentToolGroup = null;
  let toolStats = { read: 0, write: 0, err: 0 };

  function getOrCreateToolGroup() {
    if (currentToolGroup) return currentToolGroup;
    
    const summaryText = el('span', { class: 'tool-summary-text' }, 'Trabalhando nos arquivos...');
    const toggleBtn = el('button', { class: 'tool-group-toggle' }, 'Ver detalhes');
    const header = el('div', { class: 'tool-group-header' }, [summaryText, toggleBtn]);
    const details = el('div', { class: 'tool-group-details', style: 'display: none;' });
    
    currentToolGroup = {
      node: el('div', { class: 'msg tool-group' }, [header, details]),
      details,
      summaryText,
      updateSummary: () => {
        const parts = [];
        if (toolStats.read) parts.push(`${toolStats.read} lido${toolStats.read > 1 ? 's' : ''}`);
        if (toolStats.write) parts.push(`${toolStats.write} editado${toolStats.write > 1 ? 's' : ''}`);
        if (toolStats.err) parts.push(`${toolStats.err} erro${toolStats.err > 1 ? 's' : ''}`);
        summaryText.textContent = parts.length ? parts.join(', ') : 'Trabalhando...';
        if (toolStats.err) summaryText.classList.add('has-error');
      }
    };

    toggleBtn.addEventListener('click', () => {
      const isHidden = details.style.display === 'none';
      details.style.display = isHidden ? 'flex' : 'none';
      toggleBtn.textContent = isHidden ? 'Ocultar detalhes' : 'Ver detalhes';
    });

    if (assistantNode && assistantNode.parentElement) {
      msgsBox.insertBefore(currentToolGroup.node, assistantNode.parentElement);
    } else {
      msgsBox.appendChild(currentToolGroup.node);
    }
    return currentToolGroup;
  }

  // Conecta ao Runner Global
  const unsubscribe = AgentRunner.subscribe((ev) => {
    const thinkingHtml = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';

    if (ev.type === 'start') {
      sendBtn.disabled = true;
      msgsBox.querySelector('.welcome-box')?.remove();
      if (!history.find(m => m.role === 'user' && m.content === ev.text)) {
        msgsBox.appendChild(bubble('user', el('div', { html: renderInlineMd(ev.text) })));
      }
      assistantNode = el('div', { class: 'thinking', html: thinkingHtml });
      msgsBox.appendChild(bubble('assistant', assistantNode));
      msgsBox.scrollTop = msgsBox.scrollHeight;
    } else if (ev.type === 'thinking') {
      if (!assistantNode) {
        assistantNode = el('div', { class: 'thinking', html: thinkingHtml });
        msgsBox.appendChild(bubble('assistant', assistantNode));
      }
      assistantNode.className = 'thinking';
      assistantNode.innerHTML = thinkingHtml;
      currentToolGroup = null;
      toolStats = { read: 0, write: 0, err: 0 };
    } else if (ev.type === 'assistant_text' && ev.text) {
      if (assistantNode) {
        assistantNode.className = '';
        assistantNode.innerHTML = renderInlineMd(ev.text);
      }
    } else if (ev.type === 'tool_call') {
      const group = getOrCreateToolGroup();
      if (ev.name.includes('read') || ev.name.includes('list')) toolStats.read++;
      else toolStats.write++;
      group.updateSummary();
      
      group.details.appendChild(el('div', { class: 'tool-item call' }, [
        el('div', { class: 'tool-name' }, `→ ${ev.name}`),
        el('pre', {}, fmtArgs(ev.args)),
      ]));
    } else if (ev.type === 'tool_result') {
      const group = getOrCreateToolGroup();
      group.details.appendChild(el('div', { class: 'tool-item ok' }, [
        el('div', { class: 'tool-name' }, `✓ ${ev.name}`),
        el('pre', {}, fmtArgs(ev.result).slice(0, 1000) + (JSON.stringify(ev.result).length > 1000 ? '...' : '')),
      ]));
    } else if (ev.type === 'tool_error') {
      const group = getOrCreateToolGroup();
      toolStats.err++;
      group.updateSummary();
      group.details.appendChild(el('div', { class: 'tool-item err' }, [
        el('div', { class: 'tool-name' }, `✗ ${ev.name}`),
        el('div', { class: 'error-banner-inline' }, ev.error),
      ]));
    } else if (ev.type === 'usage') {
      totalTk += (ev.usage.input || 0) + (ev.usage.output || 0);
      totalCost += ev.cost || 0;
      tokPill.textContent = fmtTokens(totalTk) + ' tk';
      costPill.textContent = fmtCost(totalCost);
    } else if (ev.type === 'error') {
      if (assistantNode) {
        assistantNode.className = '';
        assistantNode.appendChild(el('div', { class: 'error-banner-inline' }, ev.message));
      }
    } else if (ev.type === 'retry') {
      if (assistantNode) {
        assistantNode.className = '';
        assistantNode.appendChild(el('div', { class: 'error-banner-inline', style: 'background: var(--warn-soft); color: var(--warn); border-color: var(--warn);' }, ev.message));
      }
    } else if (ev.type === 'approval_request') {
      askApproval(msgsBox, ev.req, ev.resolve);
    } else if (ev.type === 'done') {
      sendBtn.disabled = false;
      history = AgentRunner.history;
    }
    
    msgsBox.scrollTop = msgsBox.scrollHeight;
  });

  if (AgentRunner.isRunning) {
    sendBtn.disabled = true;
  }

  const observer = new MutationObserver((mutations) => {
    if (!document.body.contains(shell)) {
      unsubscribe();
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    if (teamMode && !repo) {
      msgsBox.appendChild(el('div', { class: 'error-banner-inline' },
        'O modo equipe precisa de um repositório ativo. Selecione um na aba Repos.'));
      msgsBox.scrollTop = msgsBox.scrollHeight;
      return;
    }

    input.value = '';
    sendBtn.disabled = true;

    msgsBox.querySelector('.welcome-box')?.remove();
    msgsBox.appendChild(bubble('user', el('div', { html: renderInlineMd(text) })));
    msgsBox.scrollTop = msgsBox.scrollHeight;

    const thinkingHtml = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    const assistantNode = el('div', { class: 'thinking', html: thinkingHtml });
    msgsBox.appendChild(bubble('assistant', assistantNode));

    try {
      if (teamMode) await sendTeam(text, assistantNode);
      else await sendSolo(text, assistantNode, thinkingHtml);
    } finally {
      sendBtn.disabled = false;
      msgsBox.scrollTop = msgsBox.scrollHeight;
    }
  }
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  msgsBox.scrollTop = msgsBox.scrollHeight;
}
