import type { UserEntry } from "../config.js";

export type { UserEntry } from "../config.js";

/** `config.users[]` 이메일 → macOS 계정 매핑(대소문자 무시). */
export class UserDirectory {
  private readonly entries: Map<string, UserEntry>;

  constructor(users: readonly UserEntry[]) {
    this.entries = new Map(users.map((u) => [u.email.trim().toLowerCase(), u]));
  }

  byEmail(email: string): UserEntry | null {
    return this.entries.get(email.trim().toLowerCase()) ?? null;
  }

  list(): UserEntry[] {
    return [...this.entries.values()];
  }
}
