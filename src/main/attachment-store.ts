import { lstat, readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_LIMITS,
  type AttachmentSummary,
  type SelectedAttachment,
} from "../shared/types.ts";
import { containsLikelySecret, isSensitivePath } from "./security.ts";
import { MAX_MEDIA_BYTES, mediaMimeType } from "./vision.ts";

const TOKEN_TTL_MS = 15 * 60 * 1000;

const SUPPORTED_TEXT_EXTENSIONS = new Set([
  "",
  ".astro",
  ".bash",
  ".c",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".fish",
  ".go",
  ".gql",
  ".graphql",
  ".h",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".kt",
  ".kts",
  ".log",
  ".markdown",
  ".md",
  ".mdx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsv",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);

interface StoredAttachmentBase extends SelectedAttachment {
  kind: "text" | "media";
  mimeType?: string;
  expiresAt: number;
}

interface StoredTextAttachment extends StoredAttachmentBase {
  kind: "text";
  content: string;
}

interface StoredMediaAttachment extends StoredAttachmentBase {
  kind: "media";
  mimeType: string;
  bytes: Buffer;
}

type StoredAttachment = StoredTextAttachment | StoredMediaAttachment;

export interface ResolvedTextAttachment {
  summary: AttachmentSummary;
  kind: "text";
  content: string;
}

export interface ResolvedMediaAttachment {
  summary: AttachmentSummary;
  kind: "media";
  mimeType: string;
  bytes: Buffer;
}

export type ResolvedAttachment = ResolvedTextAttachment | ResolvedMediaAttachment;

function decodeText(buffer: Buffer, name: string): string {
  if (buffer.includes(0)) {
    throw new Error(`${name} 是二进制文件，第一版仅支持文本附件。`);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${name} 不是有效的 UTF-8 文本文件。`);
  }
}

function assertNoSecrets(name: string, content: string): void {
  if (isSensitivePath(name) || containsLikelySecret(content)) {
    throw new Error(`${name} 可能包含密钥或凭据，已阻止作为附件发送。`);
  }
}

export class AttachmentStore {
  private readonly attachments = new Map<string, StoredAttachment>();

  async addFiles(
    filePaths: string[],
    maxCount: number = ATTACHMENT_LIMITS.maxCount,
  ): Promise<SelectedAttachment[]> {
    this.pruneExpired();
    const allowedCount = Math.max(1, Math.min(maxCount, ATTACHMENT_LIMITS.maxCount));
    if (filePaths.length === 0) return [];
    if (filePaths.length > allowedCount) {
      throw new Error(`一次最多还能添加 ${allowedCount} 个附件。`);
    }

    const loaded = await Promise.all(filePaths.map((filePath) => this.loadFile(filePath)));
    const totalBytes = loaded.reduce((total, item) => total + item.size, 0);
    if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error("附件总大小不能超过 18 MB。");
    }

    for (const attachment of loaded) this.attachments.set(attachment.id, attachment);
    return loaded.map(({ id, name, size, kind }) => ({ id, name, size, kind }));
  }

  consume(ids: string[]): ResolvedAttachment[] {
    this.pruneExpired();
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) throw new Error("附件列表包含重复项。");
    if (uniqueIds.length > ATTACHMENT_LIMITS.maxCount) {
      throw new Error(`一次最多发送 ${ATTACHMENT_LIMITS.maxCount} 个附件。`);
    }

    const resolved = uniqueIds.map((id) => {
      const attachment = this.attachments.get(id);
      if (!attachment) throw new Error("附件已失效，请重新选择后再发送。");
      return attachment;
    });
    const totalBytes = resolved.reduce((total, item) => total + item.size, 0);
    if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
      throw new Error("附件总大小不能超过 18 MB。");
    }

    for (const id of uniqueIds) this.attachments.delete(id);
    return resolved.map((attachment): ResolvedAttachment => attachment.kind === "text"
      ? {
          summary: { name: attachment.name, size: attachment.size, kind: "text" },
          kind: "text",
          content: attachment.content,
        }
      : {
          summary: { name: attachment.name, size: attachment.size, kind: "media" },
          kind: "media",
          mimeType: attachment.mimeType,
          bytes: attachment.bytes,
        });
  }

  release(ids: string[]): void {
    for (const id of ids) this.attachments.delete(id);
  }

  private async loadFile(filePath: string): Promise<StoredAttachment> {
    const name = basename(filePath);
    const extension = extname(name).toLowerCase();
    const mimeType = mediaMimeType(name);
    if (!SUPPORTED_TEXT_EXTENSIONS.has(extension) && !mimeType) {
      throw new Error(`${name} 暂不支持；可添加文本、代码、PNG、JPG、GIF、WebP 和 PDF。`);
    }
    if (isSensitivePath(name)) throw new Error(`${name} 可能包含密钥或凭据，已阻止作为附件发送。`);
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new Error(`${name} 是符号链接，不能作为附件发送。`);
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error(`${name} 不是普通文件。`);
    const limit = mimeType ? ATTACHMENT_LIMITS.maxMediaFileBytes : ATTACHMENT_LIMITS.maxTextFileBytes;
    if (fileStat.size > limit || (mimeType && fileStat.size > MAX_MEDIA_BYTES)) {
      throw new Error(`${name} 超过${mimeType ? " 15 MB" : " 256 KB"}的单文件限制。`);
    }

    const buffer = await readFile(filePath);
    if (mimeType) {
      return {
        id: randomUUID(),
        name,
        size: buffer.byteLength,
        kind: "media",
        mimeType,
        bytes: buffer,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      };
    }
    const content = decodeText(buffer, name);
    assertNoSecrets(name, content);
    return {
      id: randomUUID(),
      name,
      size: buffer.byteLength,
      kind: "text",
      content,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [id, attachment] of this.attachments) {
      if (attachment.expiresAt <= now) this.attachments.delete(id);
    }
  }
}
