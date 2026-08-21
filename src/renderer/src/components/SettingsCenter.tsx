import {
  Bot,
  Check,
  Eye,
  EyeOff,
  Folder,
  ImagePlus,
  Info,
  KeyRound,
  Languages,
  Monitor,
  Moon,
  ShieldCheck,
  Sun,
  TerminalSquare,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AppLanguage,
  AppSettings,
  AppTheme,
  DeepSeekModelId,
  SettingsUpdate,
} from "../../../shared/types";

type SettingsPage = "general" | "models" | "agent" | "appearance" | "about";

interface SettingsCenterProps {
  appInfo: {
    version: string;
    platform: string;
  };
  settings: AppSettings;
  onClose: () => void;
  onNotice: (message: string) => void;
  onSaved: (settings: AppSettings) => void;
}

const NAV_ITEMS = [
  { id: "general", label: "通用", icon: Languages },
  { id: "models", label: "模型", icon: Bot },
  { id: "agent", label: "智能体", icon: TerminalSquare },
  { id: "appearance", label: "外观", icon: Sun },
  { id: "about", label: "关于", icon: Info },
] satisfies ReadonlyArray<{
  id: SettingsPage;
  label: string;
  icon: typeof Languages;
}>;

const PAGE_COPY: Record<SettingsPage, { title: string; description: string }> = {
  general: {
    title: "通用",
    description: "管理本地用户资料，以及 DoWork 在整个应用中使用的语言。",
  },
  models: {
    title: "模型",
    description: "配置 DeepSeek 连接和智能体默认使用的模型。",
  },
  agent: {
    title: "智能体",
    description: "设置 DoWork 可以访问的工作区和本地操作边界。",
  },
  appearance: {
    title: "外观",
    description: "选择适合你的界面主题，设置会立即应用到整个应用。",
  },
  about: {
    title: "关于",
    description: "查看 DoWork 的版本、运行环境和当前能力。",
  },
};

const THEMES: Array<{
  id: AppTheme;
  label: string;
  description: string;
  icon: typeof Monitor;
}> = [
  { id: "system", label: "跟随系统", description: "自动匹配系统外观", icon: Monitor },
  { id: "light", label: "浅色", description: "始终使用明亮界面", icon: Sun },
  { id: "dark", label: "深色", description: "始终使用暗色界面", icon: Moon },
];

function getInitials(displayName: string): string {
  const normalized = displayName.trim();
  if (!normalized) return "DW";
  if (/^[\x00-\x7F]+$/.test(normalized)) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  }
  return normalized.slice(0, 2);
}

function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

export function SettingsCenter({
  appInfo,
  settings,
  onClose,
  onNotice,
  onSaved,
}: SettingsCenterProps) {
  const [activePage, setActivePage] = useState<SettingsPage>("general");
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [language, setLanguage] = useState<AppLanguage>(settings.language);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [modelId, setModelId] = useState<DeepSeekModelId>(settings.modelId);
  const [workspace, setWorkspace] = useState<string | null>(settings.workspace);
  const [theme, setTheme] = useState<AppTheme>(settings.theme);
  const [saving, setSaving] = useState<SettingsPage | "key" | null>(null);

  useEffect(() => {
    setDisplayName(settings.displayName);
    setLanguage(settings.language);
    setModelId(settings.modelId);
    setWorkspace(settings.workspace);
    setTheme(settings.theme);
  }, [settings]);

  const initials = useMemo(() => getInitials(displayName), [displayName]);
  const copy = PAGE_COPY[activePage];

  async function saveUpdate(
    target: SettingsPage | "key",
    update: SettingsUpdate,
    successMessage: string,
  ): Promise<boolean> {
    setSaving(target);
    try {
      const next = await window.dowork.saveSettings(update);
      onSaved(next);
      onNotice(successMessage);
      return true;
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "设置保存失败。");
      return false;
    } finally {
      setSaving(null);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    const selected = await window.dowork.selectWorkspace();
    if (selected) setWorkspace(selected);
  }

  async function clearSavedKey(): Promise<void> {
    if (!window.confirm("清除已保存的 DeepSeek API Key？")) return;
    await saveUpdate("key", { clearApiKey: true }, "已清除 DeepSeek API Key。");
    setApiKey("");
  }

  return (
    <section className="settings-center" aria-label="设置中心">
      <aside className="settings-navigation">
        <div className="settings-drag-region" />
        <h1>设置</h1>
        <nav aria-label="设置分类">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`settings-nav-item${activePage === item.id ? " settings-nav-item--active" : ""}`}
                key={item.id}
                type="button"
                aria-current={activePage === item.id ? "page" : undefined}
                onClick={() => setActivePage(item.id)}
              >
                <Icon size={21} strokeWidth={1.8} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="settings-workspace">
        <div className="settings-drag-region" />
        <button className="settings-close" type="button" aria-label="关闭设置" onClick={onClose}>
          <X size={24} strokeWidth={1.65} />
        </button>

        <div className="settings-page">
          <header className="settings-page-header">
            <h2>{copy.title}</h2>
            <p>{copy.description}</p>
          </header>

          {activePage === "general" ? (
            <div className="settings-page-body">
              <section className="settings-card profile-card">
                <div className="profile-avatar-wrap" aria-label={`昵称头像 ${initials}`}>
                  <div className="profile-avatar">{initials}</div>
                  <button
                    className="profile-avatar-action"
                    type="button"
                    onClick={() => onNotice("头像编辑将在后续版本开放。")}
                  >
                    <ImagePlus size={17} />
                    <span>修改头像</span>
                  </button>
                </div>
                <div className="profile-form">
                  <label className="settings-field-label" htmlFor="display-name">昵称</label>
                  <input
                    className="settings-input"
                    id="display-name"
                    maxLength={40}
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                  <p className="settings-field-help">默认使用 whoami 返回的系统用户名。</p>
                  <div className="settings-card-actions">
                    <button
                      className="settings-primary-button"
                      type="button"
                      disabled={saving !== null || !displayName.trim()}
                      onClick={() => void saveUpdate(
                        "general",
                        { displayName, language },
                        "通用设置已保存。",
                      )}
                    >
                      {saving === "general" ? "保存中…" : "保存资料"}
                    </button>
                  </div>
                </div>
              </section>

              <section className="settings-row">
                <div>
                  <h3>语言</h3>
                  <p>语言偏好会立即保存，并应用于所有本地工作区。</p>
                </div>
                <select
                  className="settings-select settings-select--compact"
                  aria-label="界面语言"
                  value={language}
                  onChange={(event) => {
                    const nextLanguage = event.target.value as AppLanguage;
                    setLanguage(nextLanguage);
                    void saveUpdate(
                      "general",
                      { language: nextLanguage },
                      "语言设置已保存。",
                    );
                  }}
                >
                  <option value="system">跟随系统</option>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </section>
            </div>
          ) : null}

          {activePage === "models" ? (
            <div className="settings-page-body">
              <section className="settings-card settings-card--form">
                <div className="settings-card-heading">
                  <div className="settings-card-icon"><KeyRound size={21} /></div>
                  <div>
                    <h3>DeepSeek API</h3>
                    <p>凭据只保存在本机系统安全存储中，不会写入项目文件。</p>
                  </div>
                </div>

                <div className="settings-form-grid">
                  <div>
                    <label className="settings-field-label" htmlFor="api-key">API Key</label>
                    <div className="settings-secret-field">
                      <input
                        id="api-key"
                        type={showKey ? "text" : "password"}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={settings.hasApiKey ? "已安全保存；留空则保持不变" : "填写 DeepSeek API Key"}
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                      />
                      <button
                        type="button"
                        aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                        onClick={() => setShowKey((current) => !current)}
                      >
                        {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    <div className={`settings-status-note${settings.hasApiKey ? " settings-status-note--success" : ""}`}>
                      {settings.hasApiKey ? <Check size={15} /> : <ShieldCheck size={15} />}
                      <span>{settings.hasApiKey ? "凭据已安全保存" : "等待填写凭据"}</span>
                    </div>
                  </div>

                  <div>
                    <label className="settings-field-label" htmlFor="default-model">默认模型</label>
                    <select
                      className="settings-select"
                      id="default-model"
                      value={modelId}
                      onChange={(event) => setModelId(event.target.value as DeepSeekModelId)}
                    >
                      <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                      <option value="deepseek-v4-pro">DeepSeek V4 PRO</option>
                    </select>
                    <p className="settings-field-help">Flash 响应更快；Pro 更适合复杂任务。</p>
                  </div>
                </div>

                <div className="settings-card-actions settings-card-actions--split">
                  {settings.hasApiKey ? (
                    <button
                      className="settings-text-button settings-text-button--danger"
                      type="button"
                      disabled={saving !== null}
                      onClick={() => void clearSavedKey()}
                    >
                      清除凭据
                    </button>
                  ) : <span />}
                  <button
                    className="settings-primary-button"
                    type="button"
                    disabled={saving !== null || (!settings.hasApiKey && !apiKey.trim())}
                    onClick={() => void saveUpdate(
                      "models",
                      { apiKey: apiKey || undefined, modelId },
                      "模型设置已保存。",
                    ).then((saved) => {
                      if (saved) setApiKey("");
                    })}
                  >
                    {saving === "models" ? "保存中…" : "保存模型设置"}
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {activePage === "agent" ? (
            <div className="settings-page-body">
              <section className="settings-card settings-card--form">
                <div className="settings-card-heading">
                  <div className="settings-card-icon"><Folder size={21} /></div>
                  <div>
                    <h3>本地工作区</h3>
                    <p>DoWork 只会在选定目录内读取和操作文件。</p>
                  </div>
                </div>

                <button className="settings-folder-picker" type="button" onClick={() => void chooseWorkspace()}>
                  <Folder size={18} />
                  <span>{workspace ?? "尚未选择工作区"}</span>
                  <strong>{workspace ? "更改" : "选择文件夹"}</strong>
                </button>

                <div className="permission-list" aria-label="本地文件权限">
                  <div><Check size={16} /><span>读取普通文件</span><small>无需确认</small></div>
                  <div><ShieldCheck size={16} /><span>读取敏感文件</span><small>每次确认</small></div>
                  <div><ShieldCheck size={16} /><span>写入或修改文件</span><small>每次确认</small></div>
                  <div><ShieldCheck size={16} /><span>删除文件</span><small>每次确认</small></div>
                </div>

                <div className="settings-card-actions">
                  <button
                    className="settings-primary-button"
                    type="button"
                    disabled={saving !== null || !workspace}
                    onClick={() => void saveUpdate("agent", { workspace }, "智能体设置已保存。")}
                  >
                    {saving === "agent" ? "保存中…" : "保存工作区"}
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {activePage === "appearance" ? (
            <div className="settings-page-body">
              <section className="settings-card settings-card--form">
                <div className="settings-card-heading">
                  <div className="settings-card-icon"><Sun size={21} /></div>
                  <div>
                    <h3>界面主题</h3>
                    <p>选择一种主题，保存后会应用于 DoWork 的所有窗口。</p>
                  </div>
                </div>
                <div className="theme-options" role="radiogroup" aria-label="界面主题">
                  {THEMES.map((option) => {
                    const Icon = option.icon;
                    const selected = theme === option.id;
                    return (
                      <button
                        className={`theme-option${selected ? " theme-option--selected" : ""}`}
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setTheme(option.id)}
                      >
                        <Icon size={24} />
                        <strong>{option.label}</strong>
                        <span>{option.description}</span>
                        <span className="theme-option-check">{selected ? <Check size={14} /> : null}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="settings-card-actions">
                  <button
                    className="settings-primary-button"
                    type="button"
                    disabled={saving !== null}
                    onClick={() => void saveUpdate("appearance", { theme }, "外观设置已保存。")}
                  >
                    {saving === "appearance" ? "保存中…" : "保存外观"}
                  </button>
                </div>
              </section>
            </div>
          ) : null}

          {activePage === "about" ? (
            <div className="settings-page-body">
              <section className="settings-card about-card">
                <div className="about-brand">
                  <div className="brand-mark brand-mark--about">Do</div>
                  <div>
                    <h3>DoWork</h3>
                    <p>桌面 AI 编程智能体</p>
                  </div>
                </div>
                <dl className="about-list">
                  <div><dt>版本</dt><dd>{appInfo.version}</dd></div>
                  <div><dt>运行平台</dt><dd>{platformLabel(appInfo.platform)}</dd></div>
                  <div><dt>Agent runtime</dt><dd>pi</dd></div>
                  <div><dt>模型服务</dt><dd>DeepSeek</dd></div>
                </dl>
                <div className="about-note">
                  <UserRound size={17} />
                  <span>你的会话、设置与工作区权限都保存在本机。</span>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
