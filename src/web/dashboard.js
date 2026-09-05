import { el, clear } from '../util/dom.js';
import { getGithub, setRepo, getProjects, saveProject } from '../storage.js';
import { listMyRepos } from '../github.js';

function relative(date) {
  if (!date) return 'agora';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(date)) / 60000));
  return mins < 1 ? 'agora' : mins < 60 ? `${mins} min atrás` : `${Math.floor(mins / 60)}h atrás`;
}

export class DashboardView {
  constructor(container, { onOpenProject, onCreateNewProject }) {
    this.container = container;
    this.onOpenProject = onOpenProject;
    this.onCreateNewProject = onCreateNewProject;
  }

  async render() {
    clear(this.container);
    const [github, projects] = await Promise.all([getGithub(), getProjects()]);
    const name = github.user?.login || 'Desenvolvedor';
    const page = el('div', { class: 'welcome-page' });
    const hero = el('section', { class: 'welcome-hero' }, [
      el('span', { class: 'eyebrow' }, 'TOM WEB IDE'),
      el('h1', {}, 'Vamos criar algo incrível, ' + name + '.'),
      el('p', {}, 'Comece um novo projeto ou continue trabalhando em um projeto existente.'),
    ]);
    const prompt = el('textarea', { class: 'welcome-prompt', rows: '4', placeholder: 'Descreva seu projeto...\nEx.: Crie um dashboard SaaS para gerenciamento de clientes.' });
    const create = el('button', { class: 'btn btn-primary', onclick: () => {
      const text = prompt.value.trim();
      if (!text) return prompt.focus();
      this.onCreateNewProject?.(text);
    } }, 'Criar projeto');
    const promptCard = el('section', { class: 'welcome-prompt-card' }, [
      el('label', { class: 'input-label' }, 'O que você quer criar?'), prompt,
      el('div', { class: 'welcome-prompt-footer' }, [el('span', { class: 'field-hint' }, 'A IA trabalhará no projeto real.'), create]),
    ]);
    const actions = el('div', { class: 'welcome-actions' }, [
      el('button', { class: 'btn btn-secondary', onclick: () => this.openCreateModal(prompt) }, '+ Novo projeto'),
      el('a', { class: 'btn btn-secondary', href: '#github' }, 'Importar do GitHub'),
      el('a', { class: 'btn btn-ghost', href: '#projects' }, 'Ver todos os projetos'),
    ]);
    page.append(hero, promptCard, actions);
    const recent = el('section', { class: 'recent-projects' }, [el('div', { class: 'section-title-row' }, [el('h2', {}, 'Projetos recentes'), el('span', { class: 'section-sub-tag' }, `${projects.length} projeto(s)`)])]);
    if (!projects.length) recent.appendChild(el('div', { class: 'empty-card' }, [el('h3', { class: 'empty-title' }, 'Você ainda não criou nenhum projeto.'), el('p', { class: 'empty-text' }, 'Crie um projeto ou importe um repositório do GitHub.') ]));
    else {
      const grid = el('div', { class: 'project-card-grid' });
      projects.slice(0, 6).forEach(project => grid.appendChild(el('article', { class: 'project-card' }, [
        el('h3', {}, project.name || 'Projeto sem nome'), el('p', {}, project.framework || 'Framework não detectado'),
        el('div', { class: 'project-card-meta' }, [el('span', { class: 'badge badge-ok' }, project.supabaseStatus === 'connected' ? 'Supabase ●' : 'Supabase não conectado'), el('span', {}, relative(project.updatedAt))]),
        el('button', { class: 'btn btn-primary btn-sm', onclick: async () => { if (project.repo) await setRepo(project.repo); this.onOpenProject?.(project.repo); } }, 'Abrir'),
      ])));
      recent.appendChild(grid);
    }
    page.appendChild(recent); this.container.appendChild(page);
  }

  openCreateModal(prompt) {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const name = el('input', { class: 'input-field', placeholder: 'Nome do projeto' });
    const desc = el('textarea', { class: 'textarea-field', placeholder: 'Descrição opcional', rows: '3' });
    const backend = el('select', { class: 'select-field' }, [el('option', { value: 'none' }, 'Sem backend'), el('option', { value: 'supabase' }, 'Conectar Supabase (recomendado)'), el('option', { value: 'later' }, 'Configurar depois')]);
    const close = () => backdrop.remove();
    const save = el('button', { class: 'btn btn-primary', onclick: async () => { if (!name.value.trim()) return name.focus(); const project = await saveProject({ name: name.value.trim(), description: desc.value.trim(), backend: backend.value, supabaseStatus: backend.value === 'supabase' ? 'pending' : 'not_connected' }); close(); prompt.value = ''; this.onCreateNewProject?.(project.description || `Crie estrutura inicial para ${project.name}`); } }, 'Criar projeto');
    backdrop.appendChild(el('div', { class: 'modal-box' }, [el('div', { class: 'modal-header' }, [el('h2', { class: 'modal-title' }, 'Novo projeto'), el('button', { class: 'modal-close-btn', onclick: close }, '×')]), el('label', { class: 'input-label' }, 'Nome do projeto'), name, el('label', { class: 'input-label' }, 'Descrição'), desc, el('label', { class: 'input-label' }, 'Backend'), backend, el('div', { class: 'modal-footer' }, [el('button', { class: 'btn btn-ghost', onclick: close }, 'Cancelar'), save]) ]));
    document.body.appendChild(backdrop); name.focus();
  }
}
