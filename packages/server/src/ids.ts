import { ulid } from "ulid";

export type IdPrefix = "ses" | "itm" | "apr" | "trn" | "flw";

/** `<prefix>_<ULID>` 형태의 ID. PROTOCOL.md 0절의 ID 규칙과 일치한다. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
