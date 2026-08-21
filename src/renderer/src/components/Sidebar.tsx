import {
  Check,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  Settings,
  Trash2,
} from "lucide-react";
import type { ConversationSummary } from "../../../shared/types";

interface SidebarProps {
  sessions: ConversationSummary[];
  activeSessionId: string;
  onCreateSession: () => void;
  onDeleteSession: (session: ConversationSummary) => void;
  onOpenSettings: () => void;
  onSelectSession: (sessionId: string) => void;
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export function Sidebar({
  sessions,
  activeSessionId,
  onCreateSession,
  onDeleteSession,
  onOpenSettings,
  onSelectSession,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="window-drag-region" />
      <div className="sidebar-brand">
        <span>DoWork</span>
        <MoreHorizontal aria-hidden="true" size={19} />
      </div>

      <button className="new-task-button" type="button" onClick={onCreateSession}>
        <MessageSquarePlus aria-hidden="true" size={17} />
        新任务
      </button>

      <div className="history-label">最近</div>
      <nav className="history-list" aria-label="历史对话">
        {sessions.map((session) => {
          const active = session.id === activeSessionId;
          return (
            <div className={`history-row ${active ? "history-row--active" : ""}`} key={session.id}>
              <button
                className="history-select"
                type="button"
                onClick={() => onSelectSession(session.id)}
              >
                <span className={`history-status ${session.isRunning ? "history-status--running" : ""}`}>
                  {session.isRunning ? (
                    <LoaderCircle aria-hidden="true" size={13} />
                  ) : active ? (
                    <Check aria-hidden="true" size={12} />
                  ) : null}
                </span>
                <span className="history-title">{session.title}</span>
                <time>{formatTime(session.updatedAt)}</time>
              </button>
              <button
                aria-label={`删除 ${session.title}`}
                className="history-delete"
                type="button"
                onClick={() => onDeleteSession(session)}
              >
                <Trash2 aria-hidden="true" size={14} />
              </button>
            </div>
          );
        })}
      </nav>

      <button className="sidebar-settings" type="button" onClick={onOpenSettings}>
        <Settings aria-hidden="true" size={18} />
        <span>设置</span>
      </button>
    </aside>
  );
}
