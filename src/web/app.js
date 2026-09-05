import { el, clear } from '../util/dom.js';
import { DashboardView } from './dashboard.js';
import { WorkspaceView } from './workspace.js';
import { renderGithub } from '../views/github.js';
import { renderLicense } from '../views/license.js';
import { renderConfig } from '../views/config.js';
import { getRepo, getGithub } from '../storage.js';
import { getLicenseStatus } from '../license.js';
import { syncService } from '../backend/index.js';


export class WebApp {
  constructor(rootEl) {
    this.root = rootEl;
    this.currentView = 'dashboard'; // 'dashboard' | 'workspace' | 'github' | 'license' | 'config'
    this.sidebarCollapsed = false;
    this.repo = null;
  }

  async init() {
    this.repo = await getRepo();

    // Ouve alterações no repositório ativo
    window.addEventListener('hashchange', () => this.handleRoute());
    syncService.subscribe(() => this.updateNavbarStatus());
    syncService.start().catch(() => {});

    this.renderShell();
    this.handleRoute();
  }

  handleRoute() {
    const hash = (window.location.hash || '#dashboard').replace('#', '');
    this.currentView = hash || 'dashboard';
    this.renderMainContent();
    this.updateSidebarActiveState();
  }

  updateSidebarActiveState() {
    const items = document.querySelectorAll('.sidebar-nav-item');
    items.forEach(it => {
      const route = it.dataset.route;
      it.classList.toggle('active', route === this.currentView);
    });
  }

  async updateNavbarStatus() {
    const statusEl = document.getElementById('web-nav-status');
    if (!statusEl) return;
    const lic = await getLicenseStatus();
    statusEl.innerHTML = lic.isActivated
      ? '<span class="badge badge-ok">Licença Ativa</span>'
      : '<span class="badge badge-warn">Licença Pendente</span>';
  }

  renderShell() {
    clear(this.root);

    // Top Navbar
    const navbar = el('div', { class: 'web-navbar' }, [
      el('div', { class: 'web-navbar-brand', onclick: () => { window.location.hash = '#dashboard'; } }, [
        el('div', { class: 'web-logo-icon' }, 'T'),
        el('span', { class: 'web-logo-title' }, 'TOM Web IDE'),
      ]),
      el('div', { class: 'web-navbar-center' }, [
        this.repo
          ? el('div', { class: 'web-project-title-badge' }, [
            el('span', {}, '📦'),
            el('span', {}, `${this.repo.fullName} @ ${this.repo.branch || 'main'}`),
          ])
          : el('span', { class: 'field-hint' }, 'Nenhum projeto ativo'),
      ]),
      el('div', { class: 'web-navbar-right' }, [
        el('div', { id: 'web-nav-status' }),
        el('button', {
          class: 'btn btn-secondary btn-sm',
          onclick: () => { window.location.hash = '#workspace'; },
        }, '💻 Abrir Workspace'),
      ]),
    ]);

    // Body Container (Sidebar + Content)
    const bodyContainer = el('div', { style: { flex: '1', display: 'flex', minHeight: '0', overflow: 'hidden' } });

    // Sidebar Esquerda
    const sidebar = el('div', { class: `web-sidebar${this.sidebarCollapsed ? ' collapsed' : ''}` });
    const sidebarNav = el('div', { class: 'sidebar-nav-section' }, [
      el('div', { class: 'sidebar-section-title' }, 'Menu Principal'),
      el('a', { class: 'sidebar-nav-item', 'data-route': 'dashboard', href: '#dashboard' }, [
        el('span', { class: 'sidebar-nav-icon' }, '🏠'),
        el('span', {}, 'Dashboard'),
      ]),
      el('a', { class: 'sidebar-nav-item', 'data-route': 'workspace', href: '#workspace' }, [
        el('span', { class: 'sidebar-nav-icon' }, '💻'),
        el('span', {}, 'Workspace IDE'),
      ]),
      el('a', { class: 'sidebar-nav-item', 'data-route': 'github', href: '#github' }, [
        el('span', { class: 'sidebar-nav-icon' }, '🐙'),
        el('span', {}, 'GitHub'),
      ]),
      el('div', { class: 'sidebar-section-title', style: { marginTop: '12px' } }, 'Sistema'),
      el('a', { class: 'sidebar-nav-item', 'data-route': 'license', href: '#license' }, [
        el('span', { class: 'sidebar-nav-icon' }, '🔑'),
        el('span', {}, 'Licença'),
      ]),
      el('a', { class: 'sidebar-nav-item', 'data-route': 'config', href: '#config' }, [
        el('span', { class: 'sidebar-nav-icon' }, '⚙️'),
        el('span', {}, 'Configurações'),
      ]),
    ]);

    sidebar.appendChild(sidebarNav);

    // Main Display Area
    const mainContent = el('div', { id: 'web-main-content', style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden' } });

    bodyContainer.appendChild(sidebar);
    bodyContainer.appendChild(mainContent);

    this.root.appendChild(navbar);
    this.root.appendChild(bodyContainer);

    this.updateNavbarStatus();
  }

  async renderMainContent() {
    const main = document.getElementById('web-main-content');
    if (!main) return;
    clear(main);

    this.repo = await getRepo();

    if (this.currentView === 'dashboard') {
      const dash = new DashboardView(main, {
        onOpenProject: (repo) => {
          window.location.hash = '#workspace';
        },
        onCreateNewProject: (promptText) => {
          window.location.hash = '#workspace';
        },
      });
      dash.render();
    } else if (this.currentView === 'workspace') {
      const ws = new WorkspaceView(main);
      ws.render();
    } else if (this.currentView === 'github') {
      const box = el('div', { style: { flex: '1', overflowY: 'auto', padding: '24px' } });
      renderGithub(box);
      main.appendChild(box);
    } else if (this.currentView === 'license') {
      const box = el('div', { style: { flex: '1', overflowY: 'auto', padding: '24px' } });
      renderLicense(box);
      main.appendChild(box);
    } else if (this.currentView === 'config') {
      const box = el('div', { style: { flex: '1', overflowY: 'auto', padding: '24px' } });
      renderConfig(box);
      main.appendChild(box);
    }
  }
}

// Inicializa a aplicação Web ao carregar
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app-root');
  if (root) {
    const app = new WebApp(root);
    app.init();
  }
});
