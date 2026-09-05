import { remoteConfigService } from './remote-config-service.js';

export class SkillService {
  async list() {
    const config = await remoteConfigService.cached();
    const skills = config?.skills || [];
    return skills.filter(s => s.enabled !== false);
  }

  async get(idOrSlug) {
    const skills = await this.list();
    return skills.find(s => s.id === idOrSlug || s.slug === idOrSlug) || null;
  }

  async isAvailable(idOrSlug) {
    const skill = await this.get(idOrSlug);
    return !!skill;
  }
}

export const skillService = new SkillService();

