import { app } from "electron";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Conversation,
  ConversationSummary,
  TranscriptItem,
} from "../shared/types";
import { redactSensitiveText } from "./security.ts";

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  transcript: TranscriptItem[];
  agentMessages: AgentMessage[];
}

function toConversation(record: SessionRecord, isRunning = false): Conversation {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    transcript: record.transcript,
    isRunning,
  };
}

export class SessionStore {
  private readonly sessionsDirectory: string;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor() {
    this.sessionsDirectory = join(app.getPath("userData"), "sessions");
  }

  async load(): Promise<void> {
    await mkdir(this.sessionsDirectory, { recursive: true });
    const files = await readdir(this.sessionsDirectory);

    await Promise.all(
      files
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            const raw = await readFile(join(this.sessionsDirectory, name), "utf8");
            const record = JSON.parse(raw) as SessionRecord;
            if (record.id && Array.isArray(record.transcript) && Array.isArray(record.agentMessages)) {
              this.sessions.set(record.id, record);
            }
          } catch {
            // Ignore a damaged session file so one conversation cannot prevent startup.
          }
        }),
    );
  }

  async ensureSession(): Promise<SessionRecord> {
    const first = this.listRecords()[0];
    return first ?? this.create();
  }

  async create(): Promise<SessionRecord> {
    const now = Date.now();
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      title: "新任务",
      createdAt: now,
      updatedAt: now,
      transcript: [],
      agentMessages: [],
    };
    this.sessions.set(record.id, record);
    await this.save(record);
    return record;
  }

  get(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error("会话不存在或已被删除。");
    }
    return record;
  }

  list(isRunning: (id: string) => boolean = () => false): ConversationSummary[] {
    return this.listRecords().map((record) => ({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      isRunning: isRunning(record.id),
    }));
  }

  toConversation(record: SessionRecord, isRunning = false): Conversation {
    return toConversation(record, isRunning);
  }

  async save(record: SessionRecord): Promise<void> {
    record.updatedAt = Date.now();
    this.sessions.set(record.id, record);
    const destination = join(this.sessionsDirectory, `${record.id}.json`);
    const temporary = `${destination}.tmp`;
    const serialized = JSON.stringify(
      record,
      (_key, value) => typeof value === "string" ? redactSensitiveText(value) : value,
      2,
    );
    await writeFile(temporary, `${serialized}\n`, "utf8");
    await rename(temporary, destination);
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    try {
      await unlink(join(this.sessionsDirectory, `${sessionId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private listRecords(): SessionRecord[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
