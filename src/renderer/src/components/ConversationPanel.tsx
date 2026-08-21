import {
  ArrowUp,
  ChevronDown,
  Folder,
  Paperclip,
  PanelRight,
  Square,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AppSettings,
  ApprovalRequest,
  ChatTranscriptItem,
  Conversation,
  DeepSeekModelId,
  SelectedAttachment,
} from "../../../shared/types";
import { ATTACHMENT_LIMITS as attachmentLimits } from "../../../shared/types";
import { ApprovalCard } from "./ApprovalCard";
import { ToolActivity } from "./ToolActivity";

interface ConversationPanelProps {
  session: Conversation;
  settings: AppSettings;
  approvals: ApprovalRequest[];
  onOpenSettings: () => void;
  onNotice: (message: string) => void;
  onSettingsSaved: (settings: AppSettings) => void;
}

function workspaceName(workspace: string | null): string {
  if (!workspace) return "尚未选择工作区";
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? workspace;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function MarkdownMessage({ item }: { item: ChatTranscriptItem }) {
  return (
    <div className={`chat-message chat-message--${item.role} ${item.error ? "chat-message--error" : ""}`}>
      <div className={`message-avatar message-avatar--${item.role}`}>
        {item.role === "user" ? "你" : "Do"}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{item.role === "user" ? "你" : "DoWork"}</strong>
          {item.streaming ? <span className="streaming-dot" aria-label="正在回复" /> : null}
        </div>
        <div className="markdown-body">
          {item.role === "assistant" ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer">{children}</a>
                ),
              }}
            >
              {item.text}
            </ReactMarkdown>
          ) : (
            <p>{item.text}</p>
          )}
        </div>
        {item.attachments?.length ? (
          <div className="message-attachments" aria-label="消息附件">
            {item.attachments.map((attachment, index) => (
              <span className="message-attachment" key={`${item.id}-${index}`}>
                <Paperclip aria-hidden="true" size={13} />
                <span>{attachment.name}</span>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ConversationPanel({
  session,
  settings,
  approvals,
  onOpenSettings,
  onNotice,
  onSettingsSaved,
}: ConversationPanelProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<SelectedAttachment[]>([]);
  const [selectedModel, setSelectedModel] = useState<DeepSeekModelId>(settings.modelId);
  const [savingModel, setSavingModel] = useState(false);
  const attachmentsRef = useRef<SelectedAttachment[]>([]);
  const viewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setDraft("");
    const pendingIds = attachmentsRef.current.map((attachment) => attachment.id);
    if (pendingIds.length > 0) void window.dowork.releaseAttachments(pendingIds);
    attachmentsRef.current = [];
    setAttachments([]);
  }, [session.id]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => {
    setSelectedModel(settings.modelId);
  }, [settings.modelId]);

  useEffect(() => () => {
    const pendingIds = attachmentsRef.current.map((attachment) => attachment.id);
    if (pendingIds.length > 0) void window.dowork.releaseAttachments(pendingIds);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: session.isRunning ? "smooth" : "auto" });
  }, [session.transcript, session.isRunning, approvals]);

  const resizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 138)}px`;
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || session.isRunning) return;
    if (!settings.hasApiKey || !settings.workspace) {
      onOpenSettings();
      onNotice("请先完成 DeepSeek API Key 和工作区设置。");
      return;
    }
    const queuedAttachments = attachments;
    setDraft("");
    attachmentsRef.current = [];
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      await window.dowork.sendMessage(
        session.id,
        text,
        queuedAttachments.map((attachment) => attachment.id),
      );
    } catch (error) {
      setDraft(text);
      attachmentsRef.current = queuedAttachments;
      setAttachments(queuedAttachments);
      onNotice(error instanceof Error ? error.message : "任务发送失败。");
    }
  };

  const addAttachments = async () => {
    const remaining = attachmentLimits.maxCount - attachments.length;
    if (remaining <= 0) {
      onNotice(`一次最多添加 ${attachmentLimits.maxCount} 个附件。`);
      return;
    }
    try {
      const selected = await window.dowork.selectAttachments(remaining);
      if (selected.length === 0) return;
      const nextTotal = [...attachments, ...selected]
        .reduce((total, attachment) => total + attachment.size, 0);
      if (nextTotal > attachmentLimits.maxTotalBytes) {
        void window.dowork.releaseAttachments(selected.map((attachment) => attachment.id));
        onNotice("附件总大小不能超过 18 MB。");
        return;
      }
      setAttachments((current) => [...current, ...selected]);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法添加附件。");
    }
  };

  const removeAttachment = (attachmentId: string) => {
    void window.dowork.releaseAttachments([attachmentId]);
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
  };

  const stop = async () => {
    try {
      await window.dowork.abort(session.id);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法停止任务。");
    }
  };

  const changeModel = async (modelId: DeepSeekModelId) => {
    if (modelId === settings.modelId || savingModel || session.isRunning) return;
    setSelectedModel(modelId);
    setSavingModel(true);
    try {
      const nextSettings = await window.dowork.saveSettings({ modelId });
      onSettingsSaved(nextSettings);
      onNotice(
        modelId === "deepseek-v4-pro"
          ? "已切换至 DeepSeek V4 PRO。"
          : "已切换至 DeepSeek V4 Flash。",
      );
    } catch (error) {
      setSelectedModel(settings.modelId);
      onNotice(error instanceof Error ? error.message : "模型切换失败。");
    } finally {
      setSavingModel(false);
    }
  };

  return (
    <section className="conversation-panel">
      <header className="conversation-header">
        <div>
          <h1>{session.title}</h1>
          <button type="button" onClick={onOpenSettings}>
            <Folder aria-hidden="true" size={13} />
            {workspaceName(settings.workspace)}
          </button>
        </div>
        <button className="header-icon-button" type="button" onClick={onOpenSettings} aria-label="打开设置">
          <PanelRight aria-hidden="true" size={18} />
        </button>
      </header>

      <div className="conversation-viewport" ref={viewportRef}>
        <div className="conversation-content">
          {session.transcript.length === 0 ? (
            <div className="empty-state">
              <div className="brand-mark brand-mark--large">Do</div>
              <h2>把工作交给 DoWork</h2>
              <p>它可以联网搜索、阅读文本附件，并整理或编辑所选工作区里的本地文件。</p>
              {!settings.workspace || !settings.hasApiKey ? (
                <button className="button button--primary" type="button" onClick={onOpenSettings}>
                  完成初始设置
                </button>
              ) : null}
            </div>
          ) : (
            <div className="transcript">
              {session.transcript.map((item) =>
                item.kind === "chat" ? (
                  <MarkdownMessage item={item} key={item.id} />
                ) : (
                  <ToolActivity item={item} key={item.id} />
                ),
              )}
            </div>
          )}

          {approvals.map((approval) => (
            <ApprovalCard approval={approval} key={approval.id} onNotice={onNotice} />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        <div className={`composer ${session.isRunning ? "composer--running" : ""}`}>
          {attachments.length > 0 ? (
            <div className="composer-attachments" aria-label="待发送附件">
              {attachments.map((attachment) => (
                <span className="composer-attachment" key={attachment.id}>
                  <Paperclip aria-hidden="true" size={13} />
                  <span title={attachment.name}>{attachment.name}</span>
                  <small>{formatAttachmentSize(attachment.size)}</small>
                  <button
                    type="button"
                    aria-label={`移除附件 ${attachment.name}`}
                    disabled={session.isRunning}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    <X aria-hidden="true" size={13} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            aria-label="给 DoWork 的任务"
            placeholder={session.isRunning ? "DoWork 正在处理任务…" : "你想让 DoWork 做什么？"}
            value={draft}
            disabled={session.isRunning}
            onChange={(event) => {
              setDraft(event.target.value);
              resizeTextarea();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-footer">
            <button
              className="composer-attachment-button"
              type="button"
              aria-label="添加附件"
              title="添加文本、图片或 PDF（文本发送给 DeepSeek，媒体发送给 Gemini）"
              disabled={session.isRunning}
              onClick={() => void addAttachments()}
            >
              <Paperclip aria-hidden="true" size={16} />
              {attachments.length > 0 ? <span>{attachments.length}</span> : null}
            </button>
            <button className="composer-workspace" type="button" onClick={onOpenSettings}>
              <Folder aria-hidden="true" size={16} />
              <span>{workspaceName(settings.workspace)}</span>
            </button>
            <div
              className={`composer-model-select${savingModel ? " composer-model-select--saving" : ""}`}
              title={session.isRunning ? "任务完成后可切换模型" : "选择后续任务使用的模型"}
            >
              <select
                aria-label="选择 DeepSeek 模型"
                value={selectedModel}
                disabled={session.isRunning || savingModel}
                onChange={(event) => {
                  void changeModel(event.target.value as DeepSeekModelId);
                }}
              >
                <option value="deepseek-v4-flash">DeepSeek V4 Flash</option>
                <option value="deepseek-v4-pro">DeepSeek V4 PRO</option>
              </select>
              <ChevronDown aria-hidden="true" size={13} />
            </div>
            <button
              className={`send-button ${session.isRunning ? "send-button--stop" : ""}`}
              type="button"
              aria-label={session.isRunning ? "停止任务" : "发送任务"}
              disabled={!session.isRunning && !draft.trim() && attachments.length === 0}
              onClick={() => (session.isRunning ? void stop() : void send())}
            >
              {session.isRunning ? <Square aria-hidden="true" size={14} fill="currentColor" /> : <ArrowUp aria-hidden="true" size={18} />}
            </button>
          </div>
        </div>
        <p className="composer-hint">Enter 发送 · 文本发给 DeepSeek · 图片/PDF 发给 Gemini · 支持联网搜索</p>
      </div>
    </section>
  );
}
