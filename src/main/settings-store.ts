import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  DEEPSEEK_MODELS,
  type AppLanguage,
  type AppSettings,
  type AppTheme,
  type DeepSeekModelId,
  type SettingsUpdate,
} from "../shared/types";

interface StoredSettings {
  encryptedApiKey?: string;
  workspace?: string | null;
  modelId?: DeepSeekModelId;
  displayName?: string;
  language?: AppLanguage;
  theme?: AppTheme;
}

const DEFAULT_MODEL: DeepSeekModelId = "deepseek-v4-flash";
const DEFAULT_LANGUAGE: AppLanguage = "system";
const DEFAULT_THEME: AppTheme = "dark";
const LANGUAGES: AppLanguage[] = ["system", "zh-CN", "en-US"];
const THEMES: AppTheme[] = ["system", "light", "dark"];

function defaultDisplayName(): string {
  try {
    return userInfo().username || "DoWork 用户";
  } catch {
    return "DoWork 用户";
  }
}

export class SettingsStore {
  private readonly settingsPath: string;
  private stored: StoredSettings = {};

  constructor() {
    this.settingsPath = join(app.getPath("userData"), "settings.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      const parsed = JSON.parse(raw) as StoredSettings;
      this.stored = {
        encryptedApiKey:
          typeof parsed.encryptedApiKey === "string" ? parsed.encryptedApiKey : undefined,
        workspace: typeof parsed.workspace === "string" ? parsed.workspace : null,
        modelId: DEEPSEEK_MODELS.includes(parsed.modelId as DeepSeekModelId)
          ? parsed.modelId
          : DEFAULT_MODEL,
        displayName:
          typeof parsed.displayName === "string" && parsed.displayName.trim()
            ? parsed.displayName.trim().slice(0, 40)
            : defaultDisplayName(),
        language: LANGUAGES.includes(parsed.language as AppLanguage)
          ? parsed.language
          : DEFAULT_LANGUAGE,
        theme: THEMES.includes(parsed.theme as AppTheme) ? parsed.theme : DEFAULT_THEME,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.stored = {
        workspace: null,
        modelId: DEFAULT_MODEL,
        displayName: defaultDisplayName(),
        language: DEFAULT_LANGUAGE,
        theme: DEFAULT_THEME,
      };
    }
  }

  getPublic(): AppSettings {
    return {
      hasApiKey: Boolean(process.env.DEEPSEEK_API_KEY || this.stored.encryptedApiKey),
      workspace: this.stored.workspace ?? null,
      modelId: this.stored.modelId ?? DEFAULT_MODEL,
      displayName: this.stored.displayName ?? defaultDisplayName(),
      language: this.stored.language ?? DEFAULT_LANGUAGE,
      theme: this.stored.theme ?? DEFAULT_THEME,
    };
  }

  getApiKey(): string {
    if (process.env.DEEPSEEK_API_KEY) {
      return process.env.DEEPSEEK_API_KEY;
    }

    if (!this.stored.encryptedApiKey) {
      throw new Error("请先在设置中填写 DeepSeek API Key。");
    }

    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储当前不可用，请配置 DEEPSEEK_API_KEY 环境变量。");
    }

    try {
      return safeStorage.decryptString(Buffer.from(this.stored.encryptedApiKey, "base64"));
    } catch {
      throw new Error("无法读取已保存的 API Key，请在设置中重新填写。");
    }
  }

  async update(update: SettingsUpdate): Promise<AppSettings> {
    if (update.apiKey !== undefined) {
      const trimmed = update.apiKey.trim();
      if (trimmed) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error("系统安全存储不可用，API Key 未保存。请改用 DEEPSEEK_API_KEY 环境变量。");
        }
        this.stored.encryptedApiKey = safeStorage.encryptString(trimmed).toString("base64");
      }
    }

    if (update.clearApiKey) {
      delete this.stored.encryptedApiKey;
    }

    if (update.workspace !== undefined) {
      this.stored.workspace = update.workspace;
    }

    if (update.modelId !== undefined) {
      if (!DEEPSEEK_MODELS.includes(update.modelId)) {
        throw new Error("不支持的 DeepSeek 模型。");
      }
      this.stored.modelId = update.modelId;
    }

    if (update.displayName !== undefined) {
      const displayName = update.displayName.trim();
      if (!displayName) throw new Error("昵称不能为空。");
      this.stored.displayName = displayName.slice(0, 40);
    }

    if (update.language !== undefined) {
      if (!LANGUAGES.includes(update.language)) throw new Error("不支持的界面语言。");
      this.stored.language = update.language;
    }

    if (update.theme !== undefined) {
      if (!THEMES.includes(update.theme)) throw new Error("不支持的外观主题。");
      this.stored.theme = update.theme;
    }

    await this.persist();
    return this.getPublic();
  }

  private async persist(): Promise<void> {
    await mkdir(app.getPath("userData"), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.stored, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.settingsPath);
  }
}
