import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspaceMemoryStore } from "../src/main/memory-store.ts";

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dowork-memory-test-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  try {
    await run(workspace);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("persists durable memory inside the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const store = new WorkspaceMemoryStore(workspace);
    await store.append(["用户偏好简洁的中文回复。"], new Date("2026-08-20T10:00:00Z"));
    const memory = await store.read();
    assert.match(memory, /2026-08-20/);
    assert.match(memory, /用户偏好简洁的中文回复/);
    assert.equal(memory, await readFile(join(workspace, ".dowork", "memory.md"), "utf8"));
  });
});

test("refuses to persist likely credentials in memory", async () => {
  await withWorkspace(async (workspace) => {
    const store = new WorkspaceMemoryStore(workspace);
    await assert.rejects(
      store.append(["api_key=very-secret-value"]),
      /密钥或凭据/,
    );
  });
});

test("supports user-directed replacement of memory", async () => {
  await withWorkspace(async (workspace) => {
    const store = new WorkspaceMemoryStore(workspace);
    await store.replace("# Memory\n\n- Use TypeScript.");
    assert.equal(await store.read(), "# Memory\n\n- Use TypeScript.\n");
  });
});
