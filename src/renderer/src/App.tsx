import { useCallback, useEffect, useState } from "react";
import type {
  AppSettings,
  ApprovalRequest,
  BootstrapData,
  Conversation,
  ConversationSummary,
  RuntimeEvent,
} from "../../shared/types";
import { ConversationPanel } from "./components/ConversationPanel";
import { SettingsCenter } from "./components/SettingsCenter";
import { Sidebar } from "./components/Sidebar";

export default function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [activeSession, setActiveSession] = useState<Conversation | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.dowork.onRuntimeEvent((event: RuntimeEvent) => {
      if (event.type === "session_updated") {
        setActiveSession((current) =>
          current?.id === event.session.id ? event.session : current,
        );
      } else if (event.type === "sessions_updated") {
        setData((current) => (current ? { ...current, sessions: event.sessions } : current));
      } else if (event.type === "approval_requested") {
        setApprovals((current) => [...current, event.approval]);
      } else if (event.type === "approval_resolved") {
        setApprovals((current) => current.filter((item) => item.id !== event.approvalId));
      } else if (event.type === "runtime_error") {
        setNotice(event.message);
      }
    });

    void window.dowork
      .bootstrap()
      .then((bootstrap) => {
        if (disposed) return;
        setData(bootstrap);
        setActiveSession(bootstrap.activeSession);
        setSettingsOpen(!bootstrap.settings.hasApiKey || !bootstrap.settings.workspace);
      })
      .catch((error: unknown) => {
        if (!disposed) setNotice(error instanceof Error ? error.message : "DoWork 启动失败。");
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const theme = data?.settings.theme;
    if (!theme) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    applyTheme();
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [data?.settings.theme]);

  const selectSession = useCallback(async (sessionId: string) => {
    try {
      const session = await window.dowork.getSession(sessionId);
      setActiveSession(session);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法打开会话。");
    }
  }, []);

  const createSession = useCallback(async () => {
    try {
      const session = await window.dowork.createSession();
      setActiveSession(session);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法创建会话。");
    }
  }, []);

  const deleteSession = useCallback(async (session: ConversationSummary) => {
    if (!window.confirm(`删除“${session.title}”及其本地对话记录？`)) return;
    try {
      const replacement = await window.dowork.deleteSession(session.id);
      setActiveSession(replacement);
      setApprovals((current) => current.filter((item) => item.sessionId !== session.id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法删除会话。");
    }
  }, []);

  const saveSettings = useCallback((settings: AppSettings) => {
    setData((current) => (current ? { ...current, settings } : current));
  }, []);

  if (!data || !activeSession) {
    return (
      <main className="loading-screen">
        <div className="brand-mark brand-mark--large">Do</div>
        <span>正在打开 DoWork…</span>
      </main>
    );
  }

  const activeApprovals = approvals.filter((item) => item.sessionId === activeSession.id);

  return (
    <main className="app-shell">
      <Sidebar
        sessions={data.sessions}
        activeSessionId={activeSession.id}
        onCreateSession={createSession}
        onDeleteSession={deleteSession}
        onOpenSettings={() => setSettingsOpen(true)}
        onSelectSession={selectSession}
      />
      <ConversationPanel
        approvals={activeApprovals}
        session={activeSession}
        settings={data.settings}
        onOpenSettings={() => setSettingsOpen(true)}
        onNotice={setNotice}
        onSettingsSaved={saveSettings}
      />
      {settingsOpen ? (
        <SettingsCenter
          appInfo={data.appInfo}
          settings={data.settings}
          onClose={() => setSettingsOpen(false)}
          onNotice={setNotice}
          onSaved={saveSettings}
        />
      ) : null}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </main>
  );
}
