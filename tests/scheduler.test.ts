import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InformationSource } from "../src/main/news-aggregator.ts";
import { computeNextRun, ScheduleStore, SchedulerService } from "../src/main/scheduler.ts";

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dowork-scheduler-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("computes hourly, daily, and weekly next runs", () => {
  const from = new Date("2026-08-20T10:30:00");
  assert.equal(computeNextRun({ cadence: "hourly", hour: 9, dayOfWeek: 1 }, from).getMinutes(), 0);
  assert.equal(computeNextRun({ cadence: "daily", hour: 9, dayOfWeek: 1 }, from).getDate(), from.getDate() + 1);
  assert.ok(computeNextRun({ cadence: "weekly", hour: 9, dayOfWeek: 1 }, from).getTime() > from.getTime());
});

test("persists schedules and writes due news reports", async () => {
  await withWorkspace(async (workspace) => {
    const source: InformationSource = {
      id: "test-news",
      name: "Test News",
      language: "en",
      weight: 25,
      fetch: async () => [{
        title: "AI agent release",
        source: "Test News",
        url: "https://example.com/agent",
        publishedAt: "2026-08-20T11:30:00.000Z",
        summary: "A detailed release summary.",
        language: "en",
        sourceId: "test-news",
        sourceWeight: 25,
      }],
    };
    const notifications: string[] = [];
    const scheduler = new SchedulerService([source], (title) => notifications.push(title));
    const task = await scheduler.add(workspace, {
      topic: "AI agent",
      cadence: "hourly",
      hour: 9,
      dayOfWeek: 1,
      language: "all",
      windowValue: 2,
      windowUnit: "hours",
      limit: 10,
    }, new Date("2026-08-20T10:00:00.000Z"));
    const store = new ScheduleStore(workspace);
    const tasks = await store.load();
    tasks[0].nextRunAt = "2026-08-20T11:00:00.000Z";
    await store.save(tasks);
    await scheduler.runDue(workspace, new Date("2026-08-20T12:00:00.000Z"));
    const updated = await store.load();
    assert.equal(updated[0].id, task.id);
    assert.ok(updated[0].lastReportPath);
    const report = await readFile(join(workspace, updated[0].lastReportPath!), "utf8");
    assert.match(report, /AI agent release/);
    assert.deepEqual(notifications, ["DoWork 资讯任务完成"]);
  });
});
