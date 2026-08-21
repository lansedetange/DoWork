import type { AgentTool } from "@earendil-works/pi-agent-core";
import { appendFile, lstat, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ApprovalManager } from "./approval-manager";
import {
  aggregateNews,
  createDefaultNewsSources,
  type AggregateNewsResult,
  type InformationSource,
  type NewsLanguage,
} from "./news-aggregator.ts";
import { rejectFinalSymlink, resolveWorkspacePath } from "./file-tools.ts";
import { containsLikelySecret, redactSensitiveText } from "./security.ts";

const CONFIG_PATH = ".dowork/schedules.json";
const LOG_PATH = ".dowork/scheduler.log";
const MAX_LOG_BYTES = 1024 * 1024;

export type ScheduleCadence = "hourly" | "daily" | "weekly";

export interface ScheduledNewsTask {
  id: string;
  topic: string;
  cadence: ScheduleCadence;
  hour: number;
  dayOfWeek: number;
  language: "all" | NewsLanguage;
  windowValue: number;
  windowUnit: "hours" | "days";
  limit: number;
  enabled: boolean;
  createdAt: string;
  nextRunAt: string;
  lastRunAt?: string;
  lastReportPath?: string;
  lastError?: string;
}

export interface SchedulerNotifier {
  (title: string, body: string): void;
}

function safeSlug(value: string): string {
  const slug = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "news";
}

async function rejectDoworkSymlink(workspace: string): Promise<void> {
  try {
    if ((await lstat(join(workspace, ".dowork"))).isSymbolicLink()) {
      throw new Error(".dowork 目录不能是符号链接。");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function computeNextRun(task: Pick<ScheduledNewsTask, "cadence" | "hour" | "dayOfWeek">, from: Date): Date {
  const next = new Date(from);
  next.setMilliseconds(0);
  next.setSeconds(0);
  if (task.cadence === "hourly") {
    next.setMinutes(0);
    next.setHours(next.getHours() + 1);
    return next;
  }
  next.setHours(task.hour, 0, 0, 0);
  if (task.cadence === "daily") {
    if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }
  const delta = (task.dayOfWeek - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + delta);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 7);
  return next;
}

export class ScheduleStore {
  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async load(): Promise<ScheduledNewsTask[]> {
    const target = await resolveWorkspacePath(this.workspace, CONFIG_PATH, false);
    try {
      const raw = await readFile(target.absolutePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((task): task is ScheduledNewsTask => {
        if (!task || typeof task !== "object") return false;
        const value = task as Partial<ScheduledNewsTask>;
        return typeof value.id === "string"
          && typeof value.topic === "string"
          && ["hourly", "daily", "weekly"].includes(value.cadence ?? "")
          && typeof value.nextRunAt === "string";
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async save(tasks: ScheduledNewsTask[]): Promise<void> {
    await rejectDoworkSymlink(this.workspace);
    const target = await resolveWorkspacePath(this.workspace, CONFIG_PATH, false);
    await rejectFinalSymlink(this.workspace, CONFIG_PATH);
    await mkdir(dirname(target.absolutePath), { recursive: true });
    const temporary = `${target.absolutePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(tasks, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target.absolutePath);
  }

  async appendLog(message: string): Promise<void> {
    await rejectDoworkSymlink(this.workspace);
    const target = await resolveWorkspacePath(this.workspace, LOG_PATH, false);
    await rejectFinalSymlink(this.workspace, LOG_PATH);
    await mkdir(dirname(target.absolutePath), { recursive: true });
    try {
      if ((await stat(target.absolutePath)).size > MAX_LOG_BYTES) {
        await writeFile(target.absolutePath, "", { encoding: "utf8", mode: 0o600 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendFile(target.absolutePath, `${new Date().toISOString()} ${redactSensitiveText(message)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function reportMarkdown(task: ScheduledNewsTask, result: AggregateNewsResult): string {
  const lines = [
    `# ${task.topic} 资讯汇总`,
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 时间窗口：${result.window.since} — ${result.window.until}`,
    `- 数据源：${result.sources.join("、")}`,
    "",
  ];
  result.articles.forEach((article, index) => {
    lines.push(
      `## ${index + 1}. ${article.title}`,
      "",
      `- 来源：${article.source}`,
      `- 时间：${article.publishedAt}`,
      `- 语言：${article.language}`,
      `- 评分：${article.score}（${article.corroboration} 个来源组）`,
      `- 链接：${article.url}`,
      "",
      article.summary || "（暂无摘要）",
      "",
    );
  });
  if (result.warnings.length > 0) lines.push("## 数据源警告", "", ...result.warnings.map((warning) => `- ${redactSensitiveText(warning)}`), "");
  return `${lines.join("\n")}\n`;
}

export class SchedulerService {
  private readonly sources: InformationSource[];
  private readonly notifier: SchedulerNotifier;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    sources: InformationSource[] = createDefaultNewsSources(),
    notifier: SchedulerNotifier = () => undefined,
  ) {
    this.sources = sources;
    this.notifier = notifier;
  }

  start(getWorkspace: () => string | null): void {
    if (this.timer) return;
    const tick = () => {
      const workspace = getWorkspace();
      if (workspace) void this.runDue(workspace);
    };
    tick();
    this.timer = setInterval(tick, 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async list(workspace: string): Promise<ScheduledNewsTask[]> {
    return new ScheduleStore(workspace).load();
  }

  async add(
    workspace: string,
    input: Pick<ScheduledNewsTask, "topic" | "cadence" | "hour" | "dayOfWeek" | "language" | "windowValue" | "windowUnit" | "limit">,
    now: Date = new Date(),
  ): Promise<ScheduledNewsTask> {
    const topic = input.topic.trim();
    if (!topic) throw new Error("定时资讯主题不能为空。");
    if (containsLikelySecret(topic)) throw new Error("定时资讯主题不能包含密钥或凭据。");
    const store = new ScheduleStore(workspace);
    const tasks = await store.load();
    const task: ScheduledNewsTask = {
      ...input,
      topic,
      id: crypto.randomUUID(),
      enabled: true,
      createdAt: now.toISOString(),
      nextRunAt: computeNextRun(input, now).toISOString(),
    };
    tasks.push(task);
    await store.save(tasks);
    await store.appendLog(`created schedule ${task.id} for topic ${task.topic}`);
    return task;
  }

  async remove(workspace: string, taskId: string): Promise<boolean> {
    const store = new ScheduleStore(workspace);
    const tasks = await store.load();
    const next = tasks.filter((task) => task.id !== taskId);
    if (next.length === tasks.length) return false;
    await store.save(next);
    await store.appendLog(`removed schedule ${taskId}`);
    return true;
  }

  async runNow(workspace: string, task: ScheduledNewsTask): Promise<{ reportPath: string; result: AggregateNewsResult }> {
    return this.runWithRetry(workspace, task, new Date());
  }

  async runDue(workspace: string, now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    const store = new ScheduleStore(workspace);
    try {
      const tasks = await store.load();
      let changed = false;
      for (const task of tasks) {
        if (!task.enabled || new Date(task.nextRunAt).getTime() > now.getTime()) continue;
        changed = true;
        try {
          const { reportPath } = await this.runWithRetry(workspace, task, now);
          task.lastRunAt = now.toISOString();
          task.lastReportPath = reportPath;
          delete task.lastError;
          this.notifier("DoWork 资讯任务完成", `${task.topic} 汇总已写入 ${reportPath}`);
        } catch (error) {
          task.lastError = redactSensitiveText(error).slice(0, 500);
          await store.appendLog(`schedule ${task.id} failed: ${task.lastError}`);
          this.notifier("DoWork 资讯任务失败", `${task.topic}：${task.lastError}`);
        }
        task.nextRunAt = computeNextRun(task, now).toISOString();
      }
      if (changed) await store.save(tasks);
    } finally {
      this.running = false;
    }
  }

  private async runWithRetry(
    workspace: string,
    task: ScheduledNewsTask,
    now: Date,
  ): Promise<{ reportPath: string; result: AggregateNewsResult }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await aggregateNews(this.sources, {
          query: task.topic,
          windowValue: task.windowValue,
          windowUnit: task.windowUnit,
          language: task.language,
          limit: task.limit,
          now,
        });
        const timestamp = now.toISOString().replace(/[:.]/g, "-");
        const reportPath = `.dowork/reports/${safeSlug(task.topic)}-${timestamp}.md`;
        await rejectDoworkSymlink(workspace);
        const target = await resolveWorkspacePath(workspace, reportPath, false);
        await rejectFinalSymlink(workspace, reportPath);
        await mkdir(dirname(target.absolutePath), { recursive: true });
        await writeFile(target.absolutePath, reportMarkdown(task, result), { encoding: "utf8", mode: 0o600 });
        await new ScheduleStore(workspace).appendLog(`schedule ${task.id} wrote ${reportPath}`);
        return { reportPath, result };
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    throw lastError;
  }
}

interface SchedulerToolsOptions {
  sessionId: string;
  workspace: string;
  approvals: ApprovalManager;
  scheduler: SchedulerService;
}

export function createSchedulerTools(options: SchedulerToolsOptions): AgentTool[] {
  const createTask: AgentTool = {
    name: "schedule_news_digest",
    label: "创建定时资讯",
    description: "Create a persistent hourly, daily, or weekly news digest only when the user explicitly requests a schedule.",
    executionMode: "sequential",
    parameters: Type.Object({
      topic: Type.String({ minLength: 1, maxLength: 200 }),
      cadence: Type.Union([Type.Literal("hourly"), Type.Literal("daily"), Type.Literal("weekly")]),
      hour: Type.Optional(Type.Integer({ minimum: 0, maximum: 23, description: "Local hour for daily/weekly schedules. Defaults to 9." })),
      dayOfWeek: Type.Optional(Type.Integer({ minimum: 0, maximum: 6, description: "0=Sunday. Defaults to 1 (Monday)." })),
      language: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("zh"), Type.Literal("en")])),
      windowValue: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      windowUnit: Type.Optional(Type.Union([Type.Literal("hours"), Type.Literal("days")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params) => {
      const input = params as {
        topic: string; cadence: ScheduleCadence; hour?: number; dayOfWeek?: number;
        language?: "all" | NewsLanguage; windowValue?: number; windowUnit?: "hours" | "days"; limit?: number;
      };
      const task = await options.scheduler.add(options.workspace, {
        topic: input.topic.trim(),
        cadence: input.cadence,
        hour: input.hour ?? 9,
        dayOfWeek: input.dayOfWeek ?? 1,
        language: input.language ?? "all",
        windowValue: input.windowValue ?? (input.cadence === "hourly" ? 1 : 1),
        windowUnit: input.windowUnit ?? (input.cadence === "hourly" ? "hours" : "days"),
        limit: input.limit ?? 12,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(task, null, 2) }], details: { id: task.id, nextRunAt: task.nextRunAt } };
    },
  };
  const listTasks: AgentTool = {
    name: "list_scheduled_tasks",
    label: "查看定时任务",
    description: "List persistent news schedules for the current workspace.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const tasks = await options.scheduler.list(options.workspace);
      return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }], details: { count: tasks.length } };
    },
  };
  const removeTask: AgentTool = {
    name: "remove_scheduled_task",
    label: "删除定时任务",
    description: "Remove a persistent news schedule. Requires user approval.",
    executionMode: "sequential",
    parameters: Type.Object({ id: Type.String() }, { additionalProperties: false }),
    execute: async (toolCallId, params) => {
      const input = params as { id: string };
      const approved = await options.approvals.request({
        sessionId: options.sessionId,
        toolCallId,
        toolName: "remove_scheduled_task",
        title: "允许删除定时任务？",
        description: "DoWork 将停止并删除这个工作区资讯任务。",
        path: input.id,
      });
      if (!approved) throw new Error("用户已拒绝删除定时任务。");
      if (!await options.scheduler.remove(options.workspace, input.id)) throw new Error("未找到该定时任务。");
      return { content: [{ type: "text" as const, text: "定时任务已删除。" }], details: { id: input.id } };
    },
  };
  return [createTask, listTasks, removeTask];
}
