import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttachmentStore } from "../src/main/attachment-store.ts";

async function withTempFiles(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "dowork-attachment-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("loads a text attachment behind an opaque one-time id", async () => {
  await withTempFiles(async (root) => {
    const filePath = join(root, "notes.md");
    await writeFile(filePath, "# Notes\nhello", "utf8");
    const store = new AttachmentStore();
    const selected = await store.addFiles([filePath]);

    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, "notes.md");
    assert.equal("path" in selected[0], false);
    const resolved = store.consume([selected[0].id]);
    assert.equal(resolved[0].kind, "text");
    assert.equal(resolved[0].kind === "text" ? resolved[0].content : "", "# Notes\nhello");
    await assert.rejects(async () => store.consume([selected[0].id]), /附件已失效/);
  });
});

test("loads supported image attachments without exposing bytes to the renderer", async () => {
  await withTempFiles(async (root) => {
    const filePath = join(root, "diagram.png");
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    const store = new AttachmentStore();
    const selected = await store.addFiles([filePath]);
    assert.equal(selected[0].kind, "media");
    assert.equal("bytes" in selected[0], false);
    const resolved = store.consume([selected[0].id]);
    assert.equal(resolved[0].kind, "media");
    assert.equal(resolved[0].kind === "media" ? resolved[0].mimeType : "", "image/png");
  });
});

test("rejects binary attachments", async () => {
  await withTempFiles(async (root) => {
    const filePath = join(root, "binary.txt");
    await writeFile(filePath, Buffer.from([0x61, 0x00, 0x62]));
    await assert.rejects(new AttachmentStore().addFiles([filePath]), /二进制文件/);
  });
});

test("rejects attachments containing credentials", async () => {
  await withTempFiles(async (root) => {
    const filePath = join(root, "config.txt");
    await writeFile(filePath, "api_key=example-secret-value-123456", "utf8");
    await assert.rejects(new AttachmentStore().addFiles([filePath]), /可能包含密钥或凭据/);
  });
});

test("rejects sensitive credential filenames even without recognizable tokens", async () => {
  await withTempFiles(async (root) => {
    const filePath = join(root, ".env");
    await writeFile(filePath, "APP_MODE=development", "utf8");
    await assert.rejects(new AttachmentStore().addFiles([filePath]), /可能包含密钥或凭据/);
  });
});
