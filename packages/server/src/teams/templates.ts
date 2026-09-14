import type { CreateTeamTemplateRequest, PatchTeamTemplateRequest, TeamSettings, TeamTemplate, TeamTemplateMember } from "@mam/protocol";
import { InvalidRequestError, NotFoundError } from "../errors.js";
import { newId } from "../ids.js";
import type { TeamStore } from "./store.js";

/** PROTOCOL 6.1 `TeamSettings` 기본값. */
export const DEFAULT_TEAM_SETTINGS: TeamSettings = {
  maxHops: 6,
  maxConcurrent: 2,
  contextMaxMessages: 40,
  sideRoomMaxParticipants: 3,
};

function nameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

/** 팀장 정확히 1명, 이름·핸들 유일(PROTOCOL 6.2 템플릿 규칙). 위반은 400. */
export function validateTemplateMembers(members: TeamTemplateMember[]): void {
  const leads = members.filter((m) => m.isLead).length;
  if (leads !== 1) throw new InvalidRequestError(`팀장은 정확히 1명이어야 합니다 (현재 ${leads}명)`);
  const names = new Set<string>();
  const handles = new Set<string>();
  for (const m of members) {
    if (names.has(nameKey(m.name))) throw new InvalidRequestError(`같은 이름의 팀원이 있습니다: ${m.name}`);
    if (handles.has(m.handle)) throw new InvalidRequestError(`같은 핸들의 팀원이 있습니다: ${m.handle}`);
    names.add(nameKey(m.name));
    handles.add(m.handle);
  }
}

/** `TeamStore` 의 템플릿 함수 위에 얹은 얇은 CRUD: 검증·`tpl_` id·시각. */
export class TeamTemplates {
  private readonly now: () => Date;
  private readonly defaults: TeamSettings;

  constructor(
    private readonly store: TeamStore,
    opts: { now?: () => Date; defaults?: TeamSettings } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.defaults = opts.defaults ?? DEFAULT_TEAM_SETTINGS;
  }

  async list(): Promise<TeamTemplate[]> {
    return (await this.store.listTemplates()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  async get(templateId: string): Promise<TeamTemplate> {
    const template = (await this.store.listTemplates()).find((t) => t.id === templateId);
    if (!template) throw new NotFoundError(`템플릿을 찾을 수 없습니다: ${templateId}`);
    return template;
  }

  async create(input: CreateTeamTemplateRequest): Promise<TeamTemplate> {
    validateTemplateMembers(input.members);
    const at = this.now().toISOString();
    const template: TeamTemplate = {
      id: newId("tpl"),
      name: input.name,
      settings: { ...this.defaults, ...input.settings },
      members: input.members.map((m) => ({ ...m })),
      createdAt: at,
      updatedAt: at,
    };
    await this.store.saveTemplate(template);
    return template;
  }

  async patch(templateId: string, input: PatchTeamTemplateRequest): Promise<TeamTemplate> {
    const current = await this.get(templateId);
    if (input.members !== undefined) validateTemplateMembers(input.members);
    const template: TeamTemplate = {
      ...current,
      name: input.name ?? current.name,
      settings: { ...current.settings, ...input.settings },
      members: input.members !== undefined ? input.members.map((m) => ({ ...m })) : current.members,
      updatedAt: this.now().toISOString(),
    };
    await this.store.saveTemplate(template);
    return template;
  }

  async remove(templateId: string): Promise<void> {
    await this.get(templateId);
    await this.store.removeTemplate(templateId);
  }
}
