import { remoteConfigService } from './remote-config-service.js';
export class ModelService {
  async list() { return (await remoteConfigService.cached())?.models?.filter(m => m.is_active !== false) || []; }
}
export const modelService = new ModelService();
