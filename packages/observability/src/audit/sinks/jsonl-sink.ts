import fs from "node:fs";
import path from "node:path";
import type { AuditSink, SerializedAuditEvent } from "../audit-types.js";
import { serializeAuditEvent } from "../audit-serialize.js";

function toDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export type JsonlAuditSinkOptions = {
  dir: string;
  maxPayloadBytes?: number;
};

export class JsonlAuditSink implements AuditSink {
  private readonly streamByFile = new Map<string, fs.WriteStream>();

  constructor(private readonly options: JsonlAuditSinkOptions) {}

  private resolveFilePath(event: SerializedAuditEvent): string {
    const key = toDayKey(event.timestamp);
    return path.join(this.options.dir, `${key}.jsonl`);
  }

  private async ensureStream(filePath: string): Promise<fs.WriteStream> {
    const existing = this.streamByFile.get(filePath);
    if (existing) {
      return existing;
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const stream = fs.createWriteStream(filePath, { flags: "a" });
    this.streamByFile.set(filePath, stream);
    return stream;
  }

  async write(event: SerializedAuditEvent): Promise<void> {
    const filePath = this.resolveFilePath(event);
    const stream = await this.ensureStream(filePath);
    const line = `${serializeAuditEvent(event, { maxPayloadBytes: this.options.maxPayloadBytes })}\n`;
    await new Promise<void>((resolve, reject) => {
      stream.write(line, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.streamByFile.values()].map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.write("", () => resolve());
          }),
      ),
    );
  }

  async close(): Promise<void> {
    const streams = [...this.streamByFile.values()];
    this.streamByFile.clear();
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            stream.end(() => resolve());
          }),
      ),
    );
  }
}
