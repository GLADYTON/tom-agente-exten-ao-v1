// Resolução de provider/modelo, compartilhada entre o chat de agente único e o
// modo orquestrado. O modelo do agente tem prioridade; se o provider dele foi
// removido, cai no modelo ativo global.

export function lookupModel(providers, ref) {
  if (!ref) return null;
  const p = providers.find(pp => pp.id === ref.providerId);
  const m = p?.models?.find(mm => mm.id === ref.modelId);
  return p && m ? { provider: p, model: m } : null;
}

export function resolveModel(providers, agent, globalActive) {
  return lookupModel(providers, agent?.modelRef)
    || lookupModel(providers, globalActive)
    || { provider: null, model: null };
}
