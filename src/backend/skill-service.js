import { remoteConfigService } from './remote-config-service.js';
export class SkillService {
  async list() { return (await remoteConfigService.cached())?.skills?.filter(s => s.enabled !== false) || []; }
  async isAvailable(id) { return (await this.list()).some(s => s.id === id || s.slug === id); }
}
export const skillService = new SkillService();
