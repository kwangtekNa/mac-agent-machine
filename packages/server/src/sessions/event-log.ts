import { createReadStream } from "node:fs";
import { access, appendFile } from "node:fs/promises";
import { ServerEventSchema, type ServerEvent } from "@mam/protocol";
import type { ZodType } from "zod";

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/**
 * seq 순 JSONL 로그. 한 줄에 이벤트 하나. 세션 이벤트(`EventLog`)와 방 이벤트(RoomManager)가 같은 재생 규칙을 쓴다.
 * 손상된 줄·스키마 불일치 줄은 경고 후 건너뛴다(본문은 로그에 남기지 않는다).
 */
export class JsonlLog<T extends { seq: number }> {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly schema: ZodType<T>,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {}

  /** 순서를 보존하며 한 줄 append 한다. */
  append(event: T): Promise<void> {
    const write = this.chain.then(() => appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8"));
    this.chain = write.catch(() => undefined);
    return write;
  }

  /** 대기 중인 append 가 모두 끝날 때까지 기다린다. */
  flush(): Promise<void> {
    return this.chain;
  }

  /** `seq` 보다 큰 이벤트를 파일 순서대로 읽는다. 파일이 없으면 빈 결과. 손상된 줄은 건너뛴다. */
  async *readSince(seq: number): AsyncIterable<T> {
    await this.chain;
    try {
      await access(this.filePath);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    const stream = createReadStream(this.filePath, { encoding: "utf8" });
    let rest = "";
    let lineNo = 0;
    try {
      for await (const chunk of stream) {
        rest += chunk as string;
        let nl = rest.indexOf("\n");
        while (nl >= 0) {
          const line = rest.slice(0, nl);
          rest = rest.slice(nl + 1);
          lineNo += 1;
          const event = this.parseLine(line, lineNo);
          if (event && event.seq > seq) yield event;
          nl = rest.indexOf("\n");
        }
      }
      if (rest.trim().length > 0) {
        const event = this.parseLine(rest, lineNo + 1);
        if (event && event.seq > seq) yield event;
      }
    } finally {
      stream.destroy();
    }
  }

  /** 마지막 `n` 개 이벤트. */
  async tail(n: number): Promise<T[]> {
    const out: T[] = [];
    if (n <= 0) return out;
    for await (const event of this.readSince(-1)) {
      out.push(event);
      if (out.length > n) out.shift();
    }
    return out;
  }

  private parseLine(line: string, lineNo: number): T | undefined {
    if (line.trim().length === 0) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.logger.warn(`[event-log] ${this.filePath}:${lineNo} JSON 파싱 실패, 건너뜀`);
      return undefined;
    }
    const parsed = this.schema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`[event-log] ${this.filePath}:${lineNo} 스키마 불일치, 건너뜀`);
      return undefined;
    }
    return parsed.data;
  }
}

/** 세션 이벤트 로그(JSONL). 한 줄에 ServerEvent 하나, seq 순. */
export class EventLog extends JsonlLog<ServerEvent> {
  constructor(filePath: string, logger?: Pick<Console, "warn">) {
    super(filePath, ServerEventSchema, logger);
  }
}
