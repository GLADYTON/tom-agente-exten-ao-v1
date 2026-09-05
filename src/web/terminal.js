import { el, clear } from '../util/dom.js';

export class WebTerminal {
  constructor(container, { onSendErrorToAI }) {
    this.container = container;
    this.onSendErrorToAI = onSendErrorToAI;
    this.logs = [];
    this.isRunning = false;
  }

  log(text, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    this.logs.push({ text, type, timestamp });
    this.renderLogs();
  }

  clear() {
    this.logs = [];
    this.renderLogs();
  }

  renderLogs() {
    const logsBox = this.container.querySelector('.terminal-logs');
    if (!logsBox) return;
    clear(logsBox);

    this.logs.forEach(l => {
      const line = el('div', {
        style: {
          color: l.type === 'error' ? 'var(--err)' : (l.type === 'success' ? 'var(--ok)' : '#e2e8f0'),
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          lineHeight: '1.4',
        },
      }, `[${l.timestamp}] ${l.text}`);
      logsBox.appendChild(line);
    });

    logsBox.scrollTop = logsBox.scrollHeight;
  }

  render() {
    clear(this.container);

    const header = el('div', { class: 'terminal-header' }, [
      el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
        el('span', {}, '💻 TERMINAL'),
        el('span', { class: 'badge badge-ok' }, 'pronto'),
      ]),
      el('div', { style: { display: 'flex', gap: '6px' } }, [
        el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => this.clear(),
        }, 'Limpar'),
      ]),
    ]);

    const logsContainer = el('div', { class: 'terminal-logs' });

    const inputRow = el('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        padding: '6px 10px',
        background: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        gap: '8px',
      },
    });

    const promptLabel = el('span', { style: { color: 'var(--accent)', fontFamily: 'var(--mono)', fontWeight: '700' } }, '$');
    const input = el('input', {
      class: 'input-field',
      placeholder: 'npm run dev / git status / npm install...',
      style: { flex: '1', height: '28px', fontSize: '11.5px', fontFamily: 'var(--mono)' },
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        const cmd = input.value.trim();
        input.value = '';
        this.executeCommand(cmd);
      }
    });

    inputRow.appendChild(promptLabel);
    inputRow.appendChild(input);

    const terminalShell = el('div', { class: 'terminal-container' }, [
      header,
      logsContainer,
      inputRow,
    ]);

    this.container.appendChild(terminalShell);
    this.log('Web IDE Terminal Inicializado. Digite comandos ou use o agente de IA para automação.', 'info');
  }

  executeCommand(cmd) {
    this.log(`$ ${cmd}`, 'info');
    if (cmd.startsWith('npm run dev') || cmd.startsWith('npm start')) {
      this.log('Iniciando servidor de desenvolvimento em tempo real...', 'success');
      this.log('Vite v5.4.2 dev server running at http://localhost:3000', 'success');
    } else if (cmd.startsWith('git status')) {
      this.log('On branch main. Your branch is up to date with \'origin/main\'.', 'info');
    } else if (cmd.startsWith('npm install')) {
      this.log('Instalando dependências do projeto...', 'info');
      this.log('✓ Dependências atualizadas com sucesso.', 'success');
    } else {
      this.log(`Comando executado: ${cmd}`, 'info');
    }
  }
}
