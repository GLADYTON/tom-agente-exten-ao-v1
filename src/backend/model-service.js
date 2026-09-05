import { remoteConfigService } from './remote-config-service.js';

export class ModelService {
  async list() {
    const config = await remoteConfigService.cached();
    const models = config?.models || [];
    return models
      .filter(m => m.is_active !== false)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }

  async get(modelId) {
    const models = await this.list();
    return models.find(m => m.id === modelId || m.model_id === modelId) || null;
  }

  async isAuthorized(modelId) {
    const model = await this.get(modelId);
    return !!model;
  }
}

export const modelService = new ModelService();

