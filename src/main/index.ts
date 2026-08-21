import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import { join } from "node:path";
import type {
  BootstrapData,
  RuntimeEvent,
  SelectedAttachment,
  SettingsUpdate,
} from "../shared/types";
import { AgentRuntime } from "./agent-runtime";
import { ApprovalManager } from "./approval-manager";
import { AttachmentStore } from "./attachment-store";
import { SessionStore } from "./session-store";
import { SettingsStore } from "./settings-store";
import { SchedulerService } from "./scheduler";

let mainWindow: BrowserWindow | null = null;
let runtime: AgentRuntime;
let approvals: ApprovalManager;
let sessions: SessionStore;
let settings: SettingsStore;
let attachments: AttachmentStore;
let scheduler: SchedulerService;
let activeSessionId: string;

app.setName("DoWork");
app.setPath("userData", join(app.getPath("appData"), "DoWork"));

function send(event: RuntimeEvent): void {
  mainWindow?.webContents.send("dowork:runtime-event", event);
}

function sendSessionList(): void {
  send({
    type: "sessions_updated",
    sessions: sessions.list((id) => runtime.isRunning(id)),
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: "DoWork",
    backgroundColor: "#f7f8fa",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    approvals.rejectAll();
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("dowork:bootstrap", async (): Promise<BootstrapData> => {
    const activeRecord = sessions.get(activeSessionId);
    return {
      settings: settings.getPublic(),
      sessions: sessions.list((id) => runtime.isRunning(id)),
      activeSession: sessions.toConversation(activeRecord, runtime.isRunning(activeRecord.id)),
      appInfo: {
        version: app.getVersion(),
        platform: process.platform,
      },
    };
  });

  ipcMain.handle("dowork:create-session", async () => {
    const record = await sessions.create();
    activeSessionId = record.id;
    sendSessionList();
    return sessions.toConversation(record);
  });

  ipcMain.handle("dowork:get-session", (_event, sessionId: string) => {
    activeSessionId = sessionId;
    return runtime.getConversation(sessionId);
  });

  ipcMain.handle("dowork:delete-session", async (_event, sessionId: string) => {
    runtime.removeSession(sessionId);
    await sessions.delete(sessionId);
    const replacement = await sessions.ensureSession();
    activeSessionId = replacement.id;
    sendSessionList();
    return sessions.toConversation(replacement);
  });

  ipcMain.handle(
    "dowork:send-message",
    (_event, sessionId: string, text: string, attachmentIds: string[] = []) =>
      runtime.sendMessage(sessionId, text, attachmentIds),
  );

  ipcMain.handle("dowork:abort", (_event, sessionId: string) => {
    runtime.abort(sessionId);
  });

  ipcMain.handle("dowork:select-workspace", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "选择 DoWork 工作区",
      buttonLabel: "选择文件夹",
      properties: ["openDirectory", "createDirectory"],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(
    "dowork:select-attachments",
    async (_event, maxCount: number): Promise<SelectedAttachment[]> => {
      const options: Electron.OpenDialogOptions = {
        title: "添加附件",
        buttonLabel: "添加附件",
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: "支持的附件",
            extensions: [
              "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "xml", "yaml", "yml",
              "toml", "ini", "log", "js", "jsx", "ts", "tsx", "css", "scss", "html", "htm",
              "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "swift",
              "sh", "zsh", "bash", "sql", "graphql", "gql", "vue", "svelte", "astro", "mdx",
              "png", "jpg", "jpeg", "gif", "webp", "pdf",
            ],
          },
        ],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled) return [];
      const allowedCount = Number.isInteger(maxCount) ? maxCount : 1;
      return attachments.addFiles(result.filePaths, allowedCount);
    },
  );

  ipcMain.handle("dowork:release-attachments", (_event, attachmentIds: string[]) => {
    attachments.release(attachmentIds);
  });

  ipcMain.handle("dowork:save-settings", async (_event, update: SettingsUpdate) => {
    if (
      update.apiKey !== undefined ||
      update.clearApiKey ||
      update.workspace !== undefined ||
      update.modelId !== undefined
    ) {
      runtime.abortAll();
    }
    return settings.update(update);
  });

  ipcMain.handle(
    "dowork:resolve-approval",
    (_event, approvalId: string, approved: boolean) => {
      approvals.resolve(approvalId, approved);
    },
  );
}

app.whenReady().then(async () => {
  app.setAppUserModelId("com.dowork.desktop");
  settings = new SettingsStore();
  sessions = new SessionStore();
  attachments = new AttachmentStore();
  await Promise.all([settings.load(), sessions.load()]);
  const active = await sessions.ensureSession();
  activeSessionId = active.id;

  approvals = new ApprovalManager(() => mainWindow);
  scheduler = new SchedulerService(undefined, (title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  });
  runtime = new AgentRuntime(sessions, settings, approvals, attachments, scheduler, () => mainWindow);
  registerIpc();
  createWindow();
  scheduler.start(() => settings.getPublic().workspace);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  approvals?.rejectAll();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  scheduler?.stop();
});
