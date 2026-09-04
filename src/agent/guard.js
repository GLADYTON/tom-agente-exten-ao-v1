// Portões de aprovação humana.
//
// O agente roda no browser: não existe build, teste ou lint para barrar código
// quebrado antes do commit. E a revisão automática do loop acontece DEPOIS que
// o commit já foi para o repositório — ela é relatório, não portão.
//
// Aqui ficam as regras do que exige um "ok" explícito do usuário: commit em
// branch protegida e remoção de arquivo. As duas são as ações mais caras de
// desfazer pelo painel.

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'production', 'prod'];

// Aceita array ou texto livre (vírgula / quebra de linha), que é como o campo
// da tela de configurações entrega o valor.
export function parseBranchList(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]/);
  return raw.map(s => String(s).trim().toLowerCase()).filter(Boolean);
}

// Padrões suportados: nome exato (`main`), prefixo (`release/*`) e curinga (`*`).
export function isProtectedBranch(branch, patterns = DEFAULT_PROTECTED_BRANCHES) {
  const b = String(branch ?? '').trim().toLowerCase();
  if (!b) return false;

  return parseBranchList(patterns).some(p => {
    if (p === '*') return true;
    if (p.endsWith('/*')) return b.startsWith(p.slice(0, -1));
    if (p.endsWith('*')) return b.startsWith(p.slice(0, -1));
    return b === p;
  });
}

// Texto curto para o pedido de aprovação na UI.
export function describeCommitRequest({ branch, files }) {
  const n = files?.length || 0;
  return `${n} arquivo(s) em ${branch}`;
}
