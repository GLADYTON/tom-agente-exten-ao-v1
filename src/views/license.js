import { el, clear } from '../util/dom.js';
import {
  getLicenseConfig, getLicenseStatus, validateLicense, deactivateLicense,
} from '../license.js';

const keyPattern = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/;
const date = value => value ? new Date(value).toLocaleDateString('pt-BR') : 'Não informado';

export async function renderLicense(view) {
  clear(view);
  const [config, status] = await Promise.all([getLicenseConfig(), getLicenseStatus()]);
  const box = el('div', { class: 'page-section', style: { maxWidth: '620px', margin: '0 auto' } });
  view.appendChild(box);
  box.appendChild(el('div', { class: 'page-header' }, [
    el('div', {}, [el('h2', { class: 'page-title' }, 'Licença'), el('p', { class: 'page-desc' }, 'Ative licença para editar projetos GitHub.')]),
  ]));

  const notice = el('div');
  const show = (message, error = false) => {
    clear(notice);
    notice.appendChild(el('div', { class: error ? 'error-banner' : 'success-banner' }, message));
  };

  if (status.isActivated) {
    box.appendChild(el('div', { class: 'active-repo-banner' }, [
      el('div', { class: 'active-repo-badge' }, 'LICENÇA ATIVA'),
      el('div', { class: 'active-repo-content' }, [
        el('div', { class: 'active-repo-info' }, [
          el('div', { class: 'active-repo-title' }, 'Licença ativa'),
          el('div', { class: 'active-repo-meta' }, [
            el('span', {}, `Plano: ${status.plan || 'Não informado'}`),
            el('span', {}, `Expira em: ${date(status.expiresAt)}`),
            el('span', {}, `Dispositivo atual: ${status.deviceName}`),
          ]),
        ]),
      ]),
    ]));
    const actions = el('div', { class: 'modal-footer', style: { marginTop: '16px' } });
    actions.appendChild(el('button', { class: 'btn btn-ghost-danger', onclick: async () => {
      try { await deactivateLicense(); show('Dispositivo removido.'); await renderLicense(view); } catch (err) { show(err.message, true); }
    } }, 'Sair deste dispositivo'));
    if (config.renewUrl) actions.appendChild(el('button', { class: 'btn btn-primary', onclick: () => window.open(config.renewUrl, '_blank', 'noopener') }, 'Renovar Licença'));
    box.appendChild(actions);
  } else {
    const input = el('input', { class: 'input-field', placeholder: 'XXXX-XXXX-XXXX-XXXX', maxlength: '19', value: status.licenseKey });
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16).replace(/(.{4})/g, '$1-').replace(/-$/, '');
    });
    const activate = el('button', { class: 'btn btn-primary', onclick: async () => {
      const key = input.value.trim();
      if (!keyPattern.test(key)) return show('Formato inválido. Use XXXX-XXXX-XXXX-XXXX.', true);
      activate.disabled = true; activate.textContent = 'Validando...';
      try {
        if (!(await validateLicense(key))) show('Licença inválida ou expirada.', true);
        else await renderLicense(view);
      } catch (err) { show(err.message, true); }
      activate.disabled = false; activate.textContent = 'Ativar Licença';
    } }, 'Ativar Licença');
    box.appendChild(el('div', { class: 'modal-box', style: { marginTop: '16px' } }, [
      el('label', { class: 'input-label' }, 'License key'), input, notice,
      el('div', { style: { marginTop: '14px', display: 'flex', gap: '10px', alignItems: 'center' } }, [activate,
        config.purchaseUrl ? el('a', { href: config.purchaseUrl, target: '_blank', rel: 'noopener', class: 'btn btn-ghost' }, 'Onde conseguir uma licença?') : null,
      ]),
    ]));
  }

}
