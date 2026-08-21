import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lstat, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { ApprovalManager } from "./approval-manager";
import { isSensitivePath } from "./security.ts";

const MAX_READ_BYTES = 256 * 1024;
const MAX_WRITE_BYTES = 1024 * 1024;

interface FileToolsOptions {
  sessionId: string;
  workspace: string;
  approvals: ApprovalManager;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function isInside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

async function nearestExistingParent(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("无法解析目标路径。");
      current = parent;
    }
  }
}

export async function resolveWorkspacePath(
  workspace: string,
  requestedPath: string,
  mustExist: boolean,
): Promise<{ absolutePath: string; displayPath: string }> {
  const workspaceRealPath = await realpath(workspace);
  const candidate = resolve(workspaceRealPath, requestedPath || ".");

  if (!isInside(workspaceRealPath, candidate)) {
    throw new Error("路径超出当前工作区，操作已阻止。");
  }

  if (mustExist) {
    const candidateRealPath = await realpath(candidate);
    if (!isInside(workspaceRealPath, candidateRealPath)) {
      throw new Error("路径通过符号链接指向工作区外，操作已阻止。");
    }
    return {
      absolutePath: candidateRealPath,
      displayPath: relative(workspaceRealPath, candidateRealPath) || ".",
    };
  }

  const existingParent = await nearestExistingParent(candidate);
  const existingParentRealPath = await realpath(existingParent);
  if (!isInside(workspaceRealPath, existingParentRealPath)) {
    throw new Error("目标路径通过符号链接指向工作区外，操作已阻止。");
  }

  return {
    absolutePath: candidate,
    displayPath: relative(workspaceRealPath, candidate) || ".",
  };
}

export async function rejectFinalSymlink(
  workspace: string,
  requestedPath: string,
): Promise<void> {
  const workspaceRealPath = await realpath(workspace);
  const candidate = resolve(workspaceRealPath, requestedPath);
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error("修改工具不操作符号链接，请直接指定工作区内的真实文件。");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function validateTextFile(buffer: Buffer, displayPath: string): string {
  if (buffer.includes(0)) {
    throw new Error(`${displayPath} 看起来是二进制文件，第一版暂不支持。`);
  }
  return buffer.toString("utf8");
}

async function requestMutationApproval(
  options: FileToolsOptions,
  toolCallId: string,
  toolName: string,
  title: string,
  description: string,
  path: string,
): Promise<void> {
  const approved = await options.approvals.request({
    sessionId: options.sessionId,
    toolCallId,
    toolName,
    title,
    description,
    path,
  });

  if (!approved) {
    throw new Error("用户已拒绝这次文件修改。");
  }
}

export function createFileTools(options: FileToolsOptions): AgentTool[] {
  const listFilesTool: AgentTool = {
    name: "list_files",
    label: "列出文件",
    description:
      "List the direct children of a directory inside the selected workspace. Paths must be relative to the workspace.",
    parameters: Type.Object(
      {
        path: Type.Optional(Type.String({ description: "Relative directory path. Defaults to the workspace root." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      const input = params as { path?: string };
      const requestedPath = typeof input.path === "string" ? input.path : ".";
      const target = await resolveWorkspacePath(options.workspace, requestedPath, true);
      const targetStat = await stat(target.absolutePath);
      if (!targetStat.isDirectory()) throw new Error(`${target.displayPath} 不是目录。`);

      const entries = await readdir(target.absolutePath, { withFileTypes: true });
      const visibleEntries = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 200)
        .map((entry) => `${entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file"}\t${entry.name}`);
      const suffix = entries.length > 200 ? `\n… 另有 ${entries.length - 200} 项未显示` : "";
      return textResult(visibleEntries.join("\n") + suffix, {
        path: target.displayPath,
        count: entries.length,
      });
    },
  };

  const readFileTool: AgentTool = {
    name: "read_file",
    label: "读取文件",
    description:
      "Read a UTF-8 text file inside the selected workspace. Sensitive files such as .env, private keys, and credential stores require explicit user approval before their content is sent to the model.",
    parameters: Type.Object(
      { path: Type.String({ description: "Relative file path inside the workspace." }) },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, params) => {
      const input = params as { path: string };
      const target = await resolveWorkspacePath(options.workspace, input.path, true);
      const targetStat = await stat(target.absolutePath);
      if (!targetStat.isFile()) throw new Error(`${target.displayPath} 不是普通文件。`);
      if (targetStat.size > MAX_READ_BYTES) {
        throw new Error(`${target.displayPath} 超过 256 KB 的单次读取限制。`);
      }
      if (isSensitivePath(target.displayPath)) {
        const approved = await options.approvals.request({
          sessionId: options.sessionId,
          toolCallId,
          toolName: "read_file",
          title: "允许读取敏感文件？",
          description: "该文件可能包含密钥或凭据；读取后内容将发送给 DeepSeek 以完成当前任务。",
          path: target.displayPath,
        });
        if (!approved) throw new Error("用户已拒绝读取敏感文件。");
      }
      const buffer = await readFile(target.absolutePath);
      const content = validateTextFile(buffer, target.displayPath);
      return textResult(content, { path: target.displayPath, bytes: buffer.byteLength });
    },
  };

  const writeFileTool: AgentTool = {
    name: "write_file",
    label: "写入文件",
    description:
      "Create or completely replace a UTF-8 text file inside the selected workspace. Requires user approval.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        path: Type.String({ description: "Relative file path inside the workspace." }),
        content: Type.String({ description: "Complete UTF-8 content to write." }),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, params) => {
      const input = params as { path: string; content: string };
      const content = input.content;
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_WRITE_BYTES) throw new Error("写入内容超过 1 MB 限制。");
      const target = await resolveWorkspacePath(options.workspace, input.path, false);
      await rejectFinalSymlink(options.workspace, input.path);
      await requestMutationApproval(
        options,
        toolCallId,
        "write_file",
        "允许写入文件？",
        `DoWork 将写入 ${bytes.toLocaleString()} 字节，并在文件已存在时覆盖它。`,
        target.displayPath,
      );
      await mkdir(dirname(target.absolutePath), { recursive: true });
      await writeFile(target.absolutePath, content, "utf8");
      return textResult(`已写入 ${target.displayPath}`, { path: target.displayPath, bytes });
    },
  };

  const editFileTool: AgentTool = {
    name: "edit_file",
    label: "编辑文件",
    description:
      "Replace one exact text occurrence in a UTF-8 file inside the selected workspace. The old text must appear exactly once. Requires user approval.",
    executionMode: "sequential",
    parameters: Type.Object(
      {
        path: Type.String({ description: "Relative file path inside the workspace." }),
        oldText: Type.String({ description: "Exact text that currently exists once in the file." }),
        newText: Type.String({ description: "Replacement text." }),
      },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, params) => {
      const input = params as { path: string; oldText: string; newText: string };
      const target = await resolveWorkspacePath(options.workspace, input.path, true);
      await rejectFinalSymlink(options.workspace, input.path);
      const originalBuffer = await readFile(target.absolutePath);
      if (originalBuffer.byteLength > MAX_WRITE_BYTES) throw new Error("文件超过 1 MB 编辑限制。");
      const original = validateTextFile(originalBuffer, target.displayPath);
      const oldText = input.oldText;
      const newText = input.newText;
      if (!oldText) throw new Error("oldText 不能为空。");
      const occurrences = original.split(oldText).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          occurrences === 0
            ? "未找到要替换的原文，文件可能已经变化。"
            : `原文出现了 ${occurrences} 次，无法安全地确定替换位置。`,
        );
      }
      const updated = original.replace(oldText, newText);
      if (Buffer.byteLength(updated, "utf8") > MAX_WRITE_BYTES) {
        throw new Error("编辑后的文件超过 1 MB 限制。");
      }
      await requestMutationApproval(
        options,
        toolCallId,
        "edit_file",
        "允许编辑文件？",
        `DoWork 将精确替换 ${oldText.length} 个字符为 ${newText.length} 个字符。`,
        target.displayPath,
      );
      await writeFile(target.absolutePath, updated, "utf8");
      return textResult(`已编辑 ${target.displayPath}`, {
        path: target.displayPath,
        removedCharacters: oldText.length,
        addedCharacters: newText.length,
      });
    },
  };

  const deleteFileTool: AgentTool = {
    name: "delete_file",
    label: "删除文件",
    description:
      "Delete one regular file inside the selected workspace. Directories cannot be deleted. Requires user approval.",
    executionMode: "sequential",
    parameters: Type.Object(
      { path: Type.String({ description: "Relative file path inside the workspace." }) },
      { additionalProperties: false },
    ),
    execute: async (toolCallId, params) => {
      const input = params as { path: string };
      const target = await resolveWorkspacePath(options.workspace, input.path, true);
      await rejectFinalSymlink(options.workspace, input.path);
      const targetStat = await stat(target.absolutePath);
      if (!targetStat.isFile()) throw new Error("第一版只允许删除普通文件，不能删除目录或链接。");
      await requestMutationApproval(
        options,
        toolCallId,
        "delete_file",
        "允许删除文件？",
        "文件将被永久删除，此操作无法由 DoWork 撤销。",
        target.displayPath,
      );
      await unlink(target.absolutePath);
      return textResult(`已删除 ${target.displayPath}`, { path: target.displayPath });
    },
  };

  return [listFilesTool, readFileTool, writeFileTool, editFileTool, deleteFileTool];
}
