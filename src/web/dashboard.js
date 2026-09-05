import { el, clear } from '../util/dom.js';
import { getGithub, setRepo, getRepo, getChats } from '../storage.js';
import { listMyRepos } from '../github.js';


export class DashboardView {
  constructor(container, { onOpenProject, onCreateNewProject, onSelectGithubRepo }) {
    this.container = container;
    this.onOpenProject = onOpenProject;
    this.onCreateNewProject = onCreateNewProject;
    this.onSelectGithubRepo = onSelectGithubRepo;
    this.userRepos = [];
  }

  async loadRepos() {
    const github = await getGithub();
    if (github.token) {
      try {
        const res = await listMyRepos();
        this.userRepos = Array.isArray(res) ? res : (res.repos || []);
      } catch (err) {
        console.error('Error fetching repos for dashboard:', err);
      }
    }
  }

  async render() {
    clear(this.container);
    await this.loadRepos();

    const github = await getGithub();
    const username = github.user?.login || 'Desenvolvedor';

    const dash = el('div', { class: 'dashboard-container' });

    // Hero Section
    const hero = el('div', { class: 'dashboard-hero' }, [
      el('h1', {}, `Olá, ${username} 👋`),
      el('p', {}, 'O que você quer construir hoje com assistência de IA?'),
    ]);
    dash.appendChild(hero);

    // Prompt Card ("O que você quer criar?")
    const promptInput = el('textarea', {
      class: 'create-prompt-input',
      placeholder: 'Descreva o que você quer criar... Ex: "Crie uma página de login moderna com validação e modo escuro"',
    });

    const createBtn = el('button', {
      class: 'btn btn-primary',
      onclick: () => {
        const text = promptInput.value.trim();
        if (!text) return alert('Descreva o que você deseja criar.');
        this.onCreateNewProject?.(text);
      },
    }, '🚀 Criar Projeto com IA');

    const promptCard = el('div', { class: 'create-prompt-card' }, [
      promptInput,
      el('div', { class: 'create-prompt-actions' }, [
        el('div', { style: { display: 'flex', gap: '6px' } }, [
          el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => { promptInput.value = 'Crie uma landing page responsiva para o meu produto SaaS'; },
          }, '🎨 Landing Page'),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => { promptInput.value = 'Adicione uma página de login e cadastro completa'; },
          }, '🔒 Auth Page'),
          el('button', {
            class: 'btn btn-ghost btn-sm',
            onclick: () => { promptInput.value = 'Corrija o erro e refatore o componente de formulário'; },
          }, '🐛 Fix Component'),
        ]),
        createBtn,
      ]),
    ]);
    dash.appendChild(promptCard);

    // Seção de Repositórios GitHub
    const repoCard = el('div', { class: 'config-card', style: { marginBottom: '30px' } });
    repoCard.appendChild(el('div', { class: 'section-title-row' }, [
      el('div', {}, [
        el('span', { class: 'section-tag' }, `Seus Repositórios do GitHub (${this.userRepos.length})`),
        el('p', { class: 'section-sub-tag' }, 'Selecione um projeto existente para abrir no Web IDE.'),
      ]),
    ]));

    if (!github.token) {
      repoCard.appendChild(el('div', { class: 'empty-card', style: { padding: '20px' } }, [
        el('div', { class: 'empty-icon-wrap' }, '🔑'),
        el('h3', { class: 'empty-title' }, 'Conecte sua Conta do GitHub'),
        el('p', { class: 'empty-text' }, 'Vá em Configurações para adicionar seu token do GitHub e carregar seus projetos.'),
      ]));
    } else if (!this.userRepos.length) {
      repoCard.appendChild(el('div', { class: 'empty-inline', style: { padding: '16px', textAlign: 'center' } },
        'Nenhum repositório encontrado na sua conta do GitHub.'));
    } else {
      const grid = el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '12px',
          marginTop: '12px',
        },
      });

      this.userRepos.slice(0, 12).forEach(r => {
        const item = el('div', {
          class: 'agent-card-v2',
          style: { cursor: 'pointer', padding: '14px' },
          onclick: async () => {
            await setRepo({ owner: r.owner.login, repo: r.name, fullName: r.full_name, branch: r.default_branch || 'main' });
            this.onOpenProject?.(r);
          },
        }, [
          el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
            el('span', { style: { fontSize: '18px' } }, '📦'),
            el('div', { style: { fontWeight: '700', color: '#fff', fontSize: '13.5px' } }, r.name),
          ]),
          r.description ? el('div', { style: { fontSize: '11.5px', color: 'var(--text-mute)', marginTop: '6px', lineHeight: '1.4' } }, r.description) : null,
          el('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', fontSize: '11px', color: 'var(--text-dim)', fontFamily: 'var(--mono)' } }, [
            el('span', {}, `Branch: ${r.default_branch || 'main'}`),
            r.language ? el('span', { class: 'badge badge-dim' }, r.language) : null,
          ]),
        ]);
        grid.appendChild(item);
      });

      repoCard.appendChild(grid);
    }

    dash.appendChild(repoCard);
    this.container.appendChild(dash);
  }
}
