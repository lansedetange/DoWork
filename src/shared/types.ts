export const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

export const ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxTextFileBytes: 256 * 1024,
  maxMediaFileBytes: 15 * 1024 * 1024,
  maxTotalBytes: 18 * 1024 * 1024,
} as const;

export type DeepSeekModelId = (typeof DEEPSEEK_MODELS)[number];

export type AppLanguage = "system" | "zh-CN" | "en-US";
export type AppTheme = "system" | "light" | "dark";

export interface AppSettings {
  hasApiKey: boolean;
  workspace: string | null;
  modelId: DeepSeekModelId;
  displayName: string;
  language: AppLanguage;
  theme: AppTheme;
}

export interface SettingsUpdate {
  apiKey?: string;
  clearApiKey?: boolean;
  workspace?: string | null;
  modelId?: DeepSeekModelId;
  displayName?: string;
  language?: AppLanguage;
  theme?: AppTheme;
}

export interface AttachmentSummary {
  name: string;
  size: number;
  kind?: "text" | "media";
}

export interface SelectedAttachment extends AttachmentSummary {
  id: string;
}

export type TranscriptItem = ChatTranscriptItem | ToolTranscriptItem;

export interface ChatTranscriptItem {
  id: string;
  kind: "chat";
  role: "user" | "assistant";
  text: string;
  attachments?: AttachmentSummary[];
  createdAt: number;
  streaming?: boolean;
  error?: boolean;
}

export interface ToolTranscriptItem {
  id: string;
  kind: "tool";
  toolCallId: string;
  toolName: string;
  label: string;
  path?: string;
  status: "running" | "waiting" | "done" | "error" | "denied";
  summary?: string;
  createdAt: number;
  completedAt?: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  isRunning: boolean;
}

export interface Conversation extends ConversationSummary {
  transcript: TranscriptItem[];
}

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  title: string;
  description: string;
  path: string;
}

export type RuntimeEvent =
  | { type: "session_updated"; session: Conversation }
  | { type: "sessions_updated"; sessions: ConversationSummary[] }
  | { type: "approval_requested"; approval: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string }
  | { type: "runtime_error"; sessionId: string; message: string };

export interface BootstrapData {
  settings: AppSettings;
  sessions: ConversationSummary[];
  activeSession: Conversation;
  appInfo: {
    version: string;
    platform: string;
  };
}

export interface DesktopApi {
  bootstrap(): Promise<BootstrapData>;
  createSession(): Promise<Conversation>;
  getSession(sessionId: string): Promise<Conversation>;
  deleteSession(sessionId: string): Promise<Conversation>;
  sendMessage(sessionId: string, text: string, attachmentIds?: string[]): Promise<void>;
  abort(sessionId: string): Promise<void>;
  selectWorkspace(): Promise<string | null>;
  selectAttachments(maxCount: number): Promise<SelectedAttachment[]>;
  releaseAttachments(attachmentIds: string[]): Promise<void>;
  saveSettings(update: SettingsUpdate): Promise<AppSettings>;
  resolveApproval(approvalId: string, approved: boolean): Promise<void>;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
}
