import { el, clear } from '../util/dom.js';

export class WebPreview {
  constructor(container, { onFixWithAI, previewUrl = '' }) {
    this.container = container;
    this.previewUrl = previewUrl;
    this.onFixWithAI = onFixWithAI;
    this.filesMap = new Map(); // path -> content
    this.iframe = null;
    this.lastError = null;
  }

  updateFiles(files = []) {
    files.forEach(f => {
      if (typeof f === 'object' && f.path && f.content !== undefined) {
        this.filesMap.set(f.path, f.content);
      }
    });
    this.reload();
  }

  setFileContent(path, content) {
    this.filesMap.set(path, content);
    this.reload();
  }

  bundle() {
    const indexHtml = this.filesMap.get('index.html') || this.filesMap.get('public/index.html');
    if (!indexHtml) return null;
    const scriptErr = `<script>window.onerror=function(msg,url,line){window.parent.postMessage({type:'PREVIEW_ERROR',error:msg+' (linha '+line+')'},'*');};</script>`;
    return indexHtml.includes('<head>') ? indexHtml.replace('<head>', '<head>' + scriptErr) : indexHtml;
  }

  reload() {
    if (!this.iframe) return;
    if (this.previewUrl) {
      this.iframe.src = this.previewUrl;
      return;
    }
    const html = this.bundle();
    if (!html) {
      this.iframe.srcdoc = '<main style="font:16px system-ui;padding:32px">Projeto sem <code>index.html</code>. Execute Preview pelo ambiente de execução real.</main>';
      return;
    }
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    this.iframe.src = url;
  }

  render() {
    clear(this.container);

    const device = el('select', { class: 'select-field preview-device-select' }, [
      el('option', { value: 'desktop' }, 'PC'),
      el('option', { value: 'tablet' }, 'Tablet'),
      el('option', { value: 'mobile' }, 'Mobile'),
    ]);
    const openButton = el('button', { class: 'btn btn-ghost btn-sm', onclick: () => {
      if (this.previewUrl) window.open(this.previewUrl, '_blank', 'noopener');
    } }, 'Abrir');
    const nav = el('div', { class: 'preview-navbar' }, [
      el('button', {
        class: 'btn btn-ghost btn-sm',
        title: 'Recarregar Preview',
        onclick: () => this.reload(),
      }, '🔄'),
      el('input', {
        class: 'preview-url-input',
        value: 'http://localhost:3000 (Live Preview)',
        readonly: true,
      }),
      el('span', { class: 'badge badge-ok' }, this.previewUrl ? 'container live' : 'local'),
      device,
      openButton,
    ]);

    device.addEventListener('change', () => {
      const sizes = { desktop: ['100%', '100%'], tablet: ['768px', '1024px'], mobile: ['390px', '844px'] };
      const [width, height] = sizes[device.value];
      this.iframe.style.width = width;
      this.iframe.style.height = height;
      this.iframe.parentElement.style.alignItems = device.value === 'desktop' ? 'stretch' : 'center';
    });

    const previewBox = el('div', { class: 'preview-container' });
    this.iframe = el('iframe', { class: 'preview-iframe', sandbox: 'allow-scripts allow-same-origin' });
    previewBox.appendChild(this.iframe);

    const errorBanner = el('div', { class: 'error-banner-inline', style: { display: 'none', margin: '8px' } });

    window.addEventListener('message', (ev) => {
      if (ev.data?.type === 'PREVIEW_ERROR') {
        this.lastError = ev.data.error;
        clear(errorBanner);
        errorBanner.style.display = 'flex';
        errorBanner.appendChild(el('span', {}, `Erro na execução: ${this.lastError}`));
        errorBanner.appendChild(el('button', {
          class: 'btn btn-primary btn-sm',
          onclick: () => this.onFixWithAI?.(this.lastError),
        }, '✨ Corrigir com IA'));
      }
    });

    this.container.appendChild(nav);
    this.container.appendChild(errorBanner);
    this.container.appendChild(previewBox);
    this.reload();
  }
}
