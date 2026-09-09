import { createReadStream } from "node:fs";
import { access, appendFile } from "node:fs/promises";
import { ServerEventSchema, type ServerEvent } from "@mam/protocol";

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** 세션 이벤트 로그(JSONL). 한 줄에 ServerEvent 하나, seq 순. */
export class EventLog {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly logger: Pick<Console, "warn"> = console,
  ) {}

  /** 순서를 보존하며 한 줄 append 한다. */
  append(event: ServerEvent): Promise<void> {
    const write = this.chain.then(() => appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8"));
    this.chain = write.catch(() => undefined);
    return write;
  }

  /** 대기 중인 append 가 모두 끝날 때까지 기다린다. */
  flush(): Promise<void> {
    return this.chain;
  }

  /** `seq` 보다 큰 이벤트를 파일 순서대로 읽는다. 파일이 없으면 빈 결과. 손상된 줄은 건너뛴다. */
  async *readSince(seq: number): AsyncIterable<ServerEvent> {
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
  async tail(n: number): Promise<ServerEvent[]> {
    const out: ServerEvent[] = [];
    if (n <= 0) return out;
    for await (const event of this.readSince(-1)) {
      out.push(event);
      if (out.length > n) out.shift();
    }
    return out;
  }

  private parseLine(line: string, lineNo: number): ServerEvent | undefined {
    if (line.trim().length === 0) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      this.logger.warn(`[event-log] ${this.filePath}:${lineNo} JSON 파싱 실패, 건너뜀`);
      return undefined;
    }
    const parsed = ServerEventSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`[event-log] ${this.filePath}:${lineNo} 스키마 불일치, 건너뜀`);
      return undefined;
    }
    return parsed.data;
  }
}
