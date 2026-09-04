import { el, clear } from '../util/dom.js';
import { getChats, saveChats, setActiveChatId } from '../storage.js';

function emptyView(icon, title, text) {
  return el('div', { class: 'empty-card' }, [
    el('div', { class: 'empty-icon-wrap' }, icon),
    el('h3', { class: 'empty-title' }, title),
    el('p', { class: 'empty-text' }, text),
  ]);
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export async function renderChatHistory(view, switchToChat) {
  clear(view);

  const pageHeader = el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Histórico de Conversas'),
      el('p', { class: 'page-desc' }, 'Suas conversas anteriores com os agentes.'),
    ]),
    el('button', {
      class: 'btn btn-primary btn-sm',
      onclick: async () => {
        await setActiveChatId(null); // Força criar um novo chat
        switchToChat();
      }
    }, '+ Nova Conversa')
  ]);
  view.appendChild(pageHeader);

  const chats = await getChats();

  if (!chats.length) {
    view.appendChild(emptyView('💬', 'Nenhuma conversa', 'Você ainda não tem conversas salvas. Inicie um novo chat.'));
    return;
  }

  const list = el('div', { class: 'commits-list', style: { marginTop: '16px' } });

  chats.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)).forEach(chat => {
    const msgCount = chat.messages?.filter(m => m.role === 'user' || m.role === 'assistant').length || 0;
    
    const card = el('div', { class: 'account-pill-card', style: { alignItems: 'flex-start' } }, [
      el('div', { class: 'account-avatar-placeholder' }, '💬'),
      el('div', { class: 'account-meta-col' }, [
        el('div', { class: 'account-login-name' }, chat.title || 'Nova Conversa'),
        el('div', { class: 'account-status-label' }, `${msgCount} mensagens · Atualizado em ${formatTime(chat.updatedAt)}`),
      ]),
      el('div', { style: { display: 'flex', gap: '8px' } }, [
        el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: async () => {
            await setActiveChatId(chat.id);
            switchToChat();
          }
        }, 'Continuar'),
        el('button', {
          class: 'account-del-btn',
          title: 'Excluir conversa',
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm('Excluir esta conversa permanentemente?')) return;
            const newChats = chats.filter(c => c.id !== chat.id);
            await saveChats(newChats);
            renderChatHistory(view, switchToChat);
          }
        }, '🗑')
      ])
    ]);

    list.appendChild(card);
  });

  view.appendChild(list);
}
