import { el, clear } from '../util/dom.js';

export class GitPanel {
  constructor(container, { onCommitAndPush, onCreateBranch, onSwitchBranch }) {
    this.container = container;
    this.onCommitAndPush = onCommitAndPush;
    this.onCreateBranch = onCreateBranch;
    this.onSwitchBranch = onSwitchBranch;
    this.repo = null;
    this.branches = [];
    this.modifiedFiles = [];
  }

  setData({ repo, branches = [], modifiedFiles = [] }) {
    this.repo = repo;
    this.branches = branches;
    this.modifiedFiles = modifiedFiles;
    this.render();
  }

  render() {
    clear(this.container);

    const box = el('div', { class: 'config-card', style: { border: 'none', background: 'transparent' } });

    box.appendChild(el('div', { class: 'section-title-row' }, [
      el('div', {}, [
        el('span', { class: 'section-tag' }, 'Controle de Versão Git / GitHub'),
        el('p', { class: 'section-sub-tag' }, this.repo ? `${this.repo.fullName} @ ${this.repo.branch || 'main'}` : 'Nenhum repositório conectado'),
      ]),
    ]));

    if (!this.repo) {
      box.appendChild(el('div', { class: 'empty-card', style: { padding: '16px' } }, [
        el('div', { class: 'empty-icon-wrap' }, '🐙'),
        el('h3', { class: 'empty-title' }, 'Conecte um Repositório GitHub'),
        el('p', { class: 'empty-text' }, 'Selecione um repositório na barra lateral para habilitar commits e push.'),
      ]));
      this.container.appendChild(box);
      return;
    }

    // Seletor de Branch
    const branchSel = el('select', { class: 'select-field', style: { marginBottom: '12px' } });
    this.branches.forEach(b => {
      const opt = el('option', { value: b.name }, b.name);
      if (b.name === this.repo.branch) opt.selected = true;
      branchSel.appendChild(opt);
    });

    branchSel.addEventListener('change', () => {
      this.onSwitchBranch?.(branchSel.value);
    });

    const branchRow = el('div', { style: { display: 'flex', gap: '8px', marginBottom: '16px' } }, [
      branchSel,
      el('button', {
        class: 'btn btn-secondary btn-sm',
        onclick: () => {
          const name = prompt('Nome da nova branch:');
          if (name) this.onCreateBranch?.(name);
        },
      }, '+ Branch'),
    ]);
    box.appendChild(branchRow);

    // Lista de Alterações Pendentes
    const changesHeader = el('div', { class: 'input-label', style: { marginBottom: '8px' } },
      `Alterações Pendentes (${this.modifiedFiles.length})`);
    box.appendChild(changesHeader);

    if (!this.modifiedFiles.length) {
      box.appendChild(el('div', { class: 'empty-inline', style: { padding: '10px' } },
        'Nenhuma alteração pendente no workspace. O repositório está limpo.'));
    } else {
      const filesList = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '16px' } });
      this.modifiedFiles.forEach(f => {
        const item = el('div', {
          style: {
            padding: '6px 10px',
            background: 'var(--surface-2)',
            borderRadius: 'var(--r-xs)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '12px',
            fontFamily: 'var(--mono)',
          },
        }, [
          el('span', {}, f.path || f),
          el('span', { class: 'badge badge-ok' }, f.status || 'modificado'),
        ]);
        filesList.appendChild(item);
      });
      box.appendChild(filesList);
    }

    // Formulário de Commit & Push
    const commitMsgInput = el('textarea', {
      class: 'input-field',
      placeholder: 'Mensagem do commit (ex: feat: adiciona nova página de login)...',
      rows: '3',
      style: { marginBottom: '12px', resize: 'none' },
    });

    const commitBtn = el('button', {
      class: 'btn btn-primary',
      style: { width: '100%' },
      disabled: !this.modifiedFiles.length ? 'disabled' : null,
      onclick: async () => {
        const msg = commitMsgInput.value.trim();
        if (!msg) return alert('Digite uma mensagem de commit.');
        commitBtn.disabled = true;
        commitBtn.textContent = 'Enviando para GitHub...';
        try {
          await this.onCommitAndPush?.(msg, this.modifiedFiles);
          commitMsgInput.value = '';
          alert('✓ Commit e Push realizados com sucesso!');
        } catch (err) {
          alert(`Erro ao realizar push: ${err.message}`);
        } finally {
          commitBtn.disabled = false;
          commitBtn.textContent = '⚡ Commit & Push para GitHub';
        }
      },
    }, '⚡ Commit & Push para GitHub');

    box.appendChild(el('div', { class: 'form-group' }, [
      el('label', { class: 'input-label' }, 'Mensagem do Commit'),
      commitMsgInput,
      commitBtn,
    ]));

    this.container.appendChild(box);
  }
}
