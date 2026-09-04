import { el, clear } from '../util/dom.js';
import { getRepo } from '../storage.js';
import * as gh from '../github.js';

function emptyView(icon, title, text) {
  return el('div', { class: 'empty-card' }, [
    el('div', { class: 'empty-icon-wrap' }, icon),
    el('h3', { class: 'empty-title' }, title),
    el('p', { class: 'empty-text' }, text),
  ]);
}

function formatTimeAgo(dateStr) {
  const d = new Date(dateStr);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return 'agora mesmo';
  if (diff < 3600) return `${Math.floor(diff / 60)} min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}

export async function renderHistory(view) {
  clear(view);

  const pageHeader = el('div', { class: 'page-header' }, [
    el('div', {}, [
      el('h2', { class: 'page-title' }, 'Histórico de Alterações'),
      el('p', { class: 'page-desc' }, 'Resumo profissional de todas as mudanças feitas pelo agente no repositório ativo.'),
    ]),
  ]);
  view.appendChild(pageHeader);

  const repo = await getRepo();
  if (!repo) {
    view.appendChild(emptyView('📁', 'Nenhum repositório ativo', 'Selecione um repositório na aba Repo para ver o histórico de alterações.'));
    return;
  }

  const loadingBox = el('div', { class: 'loading-box' }, [
    el('div', { class: 'spinner' }),
    el('span', {}, 'Buscando histórico de commits...'),
  ]);
  view.appendChild(loadingBox);

  try {
    const [owner, repoName] = repo.fullName.split('/');
    // Busca os últimos 30 commits da branch ativa
    const commits = await gh.listCommits(owner, repoName, repo.branch);
    
    loadingBox.remove();

    if (!commits || !commits.length) {
      view.appendChild(emptyView('📝', 'Nenhuma alteração', `A branch ${repo.branch} ainda não possui commits.`));
      return;
    }

    const list = el('div', { class: 'commits-list' });

    for (const c of commits) {
      const msgLines = c.commit.message.split('\n');
      const title = msgLines[0];
      const isAgent = title.includes('Agente Tom') || c.commit.author.name.includes('Tom');
      
      // Busca detalhes do commit para saber quantos arquivos mudaram
      const detail = await gh.getCommitDetail(owner, repoName, c.sha);
      const files = detail.files || [];
      
      const addCount = files.reduce((acc, f) => acc + (f.additions || 0), 0);
      const delCount = files.reduce((acc, f) => acc + (f.deletions || 0), 0);

      const card = el('div', { class: 'commit-card-item' });
      
      const header = el('div', { class: 'commit-card-head' }, [
        el('div', { class: 'commit-author-initial' }, isAgent ? '🤖' : (c.commit.author.name[0] || '?').toUpperCase()),
        el('div', { class: 'commit-main-info' }, [
          el('div', { class: 'commit-message-title' }, title),
          el('div', { class: 'commit-meta-line' }, [
            el('span', { class: 'commit-sha-pill' }, c.sha.slice(0, 7)),
            el('span', { class: 'commit-author-name' }, c.commit.author.name),
            el('span', { class: 'commit-time-tag' }, formatTimeAgo(c.commit.author.date)),
            el('span', { class: 'text-muted' }, `· ${files.length} arquivo${files.length === 1 ? '' : 's'} alterado${files.length === 1 ? '' : 's'}`),
          ]),
        ]),
        el('div', { class: 'commit-expand-indicator' }, '▼'),
      ]);

      const drawer = el('div', { class: 'commit-detail-drawer', style: { display: 'none' } });
      
      const statsBar = el('div', { class: 'commit-stats-bar' }, [
        el('span', { class: 'stats-badge-item text-add' }, `+${addCount}`),
        el('span', { class: 'stats-badge-item text-del' }, `-${delCount}`),
        el('a', { class: 'commit-diff-link', href: c.html_url, target: '_blank' }, 'Ver diff no GitHub ↗'),
      ]);
      drawer.appendChild(statsBar);

      if (msgLines.length > 1) {
        const bodyText = msgLines.slice(1).join('\n').trim();
        if (bodyText) {
          drawer.appendChild(el('div', { class: 'commit-full-body' }, bodyText));
        }
      }

      const filesList = el('div', { class: 'commit-files-list' });
      files.forEach(f => {
        filesList.appendChild(el('div', { class: 'commit-file-row' }, [
          el('span', { class: 'commit-file-name', title: f.filename }, f.filename),
          el('div', { class: 'commit-file-diff-count' }, [
            f.additions > 0 ? el('span', { class: 'diff-add' }, `+${f.additions}`) : null,
            f.deletions > 0 ? el('span', { class: 'diff-del' }, `-${f.deletions}`) : null,
          ]),
        ]));
      });
      drawer.appendChild(filesList);

      card.appendChild(header);
      card.appendChild(drawer);

      card.addEventListener('click', (e) => {
        if (e.target.tagName === 'A') return;
        const isExpanded = card.classList.contains('is-expanded');
        if (isExpanded) {
          card.classList.remove('is-expanded');
          drawer.style.display = 'none';
        } else {
          card.classList.add('is-expanded');
          drawer.style.display = 'block';
        }
      });

      list.appendChild(card);
    }

    view.appendChild(list);

  } catch (e) {
    loadingBox.remove();
    view.appendChild(el('div', { class: 'error-banner' }, `Erro ao carregar histórico: ${e.message}`));
  }
}
