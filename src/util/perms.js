// Gateways do usuário podem apontar para qualquer domínio. Em vez de pedir
// "*://*/*" no manifest (acesso silencioso a todos os sites), o host fica em
// optional_host_permissions e é solicitado sob demanda, no clique do usuário.
//
// chrome.permissions.request() exige gesto do usuário: chame esta função como
// a PRIMEIRA await do handler de clique, senão o gesto já foi consumido.
// Quando a permissão já existe, o Chrome resolve na hora e não mostra prompt.

export function originPatternFor(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

export async function ensureOriginPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return { granted: false, error: 'URL inválida.' };
  if (!globalThis.chrome?.permissions?.request) {
    // Fora da extensão (testes) ou API indisponível: não bloqueia o fluxo.
    return { granted: true, origin, skipped: true };
  }
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted
      ? { granted: true, origin }
      : {
          granted: false,
          origin,
          error: `Permissão para acessar ${origin} foi recusada. Sem ela a extensão não pode chamar esse gateway. `
            + 'Você pode liberar depois em chrome://extensions → Agente Tom → Detalhes → Acesso ao site.',
        };
  } catch (e) {
    // Alguns contextos não contam como gesto do usuário; segue e deixa o fetch
    // falhar com a mensagem real em vez de travar aqui.
    return { granted: true, origin, warning: e.message };
  }
}

export async function hasOriginPermission(url) {
  const origin = originPatternFor(url);
  if (!origin) return false;
  if (!globalThis.chrome?.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}
