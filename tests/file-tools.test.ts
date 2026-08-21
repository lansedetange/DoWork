import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovalManager } from "../src/main/approval-manager.ts";
import { createFileTools, rejectFinalSymlink, resolveWorkspacePath } from "../src/main/file-tools.ts";

async function withWorkspace(
  run: (paths: { root: string; workspace: string; outside: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dowork-path-test-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  try {
    await run({ root, workspace, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolves a normal path inside the workspace", async () => {
  await withWorkspace(async ({ workspace }) => {
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "readme.md"), "hello", "utf8");
    const target = await resolveWorkspacePath(workspace, "docs/readme.md", true);
    assert.equal(target.absolutePath, await realpath(join(workspace, "docs", "readme.md")));
    assert.equal(target.displayPath, "docs/readme.md");
  });
});

test("rejects parent traversal outside the workspace", async () => {
  await withWorkspace(async ({ workspace }) => {
    await assert.rejects(
      resolveWorkspacePath(workspace, "../outside/secret.txt", false),
      /超出当前工作区/,
    );
  });
});

test("rejects an existing symlink that escapes the workspace", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await writeFile(join(outside, "secret.txt"), "private", "utf8");
    await symlink(outside, join(workspace, "external"));
    await assert.rejects(
      resolveWorkspacePath(workspace, "external/secret.txt", true),
      /符号链接指向工作区外/,
    );
  });
});

test("rejects a new file below a symlink that escapes the workspace", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await symlink(outside, join(workspace, "external"));
    await assert.rejects(
      resolveWorkspacePath(workspace, "external/new.txt", false),
      /符号链接指向工作区外/,
    );
  });
});

test("mutation guard rejects a final symlink even when its target is inside", async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeFile(join(workspace, "real.txt"), "keep", "utf8");
    await symlink(join(workspace, "real.txt"), join(workspace, "linked.txt"));
    await assert.rejects(
      rejectFinalSymlink(workspace, "linked.txt"),
      /修改工具不操作符号链接/,
    );
  });
});

test("requires explicit approval before reading a sensitive file", async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeFile(join(workspace, ".env"), "APP_MODE=development", "utf8");
    const requests: Array<{ title: string; description: string; path: string }> = [];
    const approvals = {
      request: async (request: { title: string; description: string; path: string }) => {
        requests.push(request);
        return false;
      },
    } as ApprovalManager;
    const tool = createFileTools({ sessionId: "session", workspace, approvals })
      .find((candidate) => candidate.name === "read_file");
    assert.ok(tool);
    await assert.rejects(tool.execute("call", { path: ".env" }), /拒绝读取敏感文件/);
    assert.equal(requests[0].title, "允许读取敏感文件？");
    assert.match(requests[0].description, /发送给 DeepSeek/);
    assert.equal(requests[0].path, ".env");
  });
});

test("reads a sensitive file only after approval", async () => {
  await withWorkspace(async ({ workspace }) => {
    await writeFile(join(workspace, ".env"), "APP_MODE=development", "utf8");
    const approvals = { request: async () => true } as unknown as ApprovalManager;
    const tool = createFileTools({ sessionId: "session", workspace, approvals })
      .find((candidate) => candidate.name === "read_file");
    assert.ok(tool);
    const result = await tool.execute("call", { path: ".env" });
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    assert.equal(text, "APP_MODE=development");
  });
});
