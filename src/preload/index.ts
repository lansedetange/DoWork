import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  BootstrapData,
  Conversation,
  DesktopApi,
  RuntimeEvent,
  SelectedAttachment,
  SettingsUpdate,
} from "../shared/types";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke("dowork:bootstrap") as Promise<BootstrapData>,
  createSession: () => ipcRenderer.invoke("dowork:create-session") as Promise<Conversation>,
  getSession: (sessionId) =>
    ipcRenderer.invoke("dowork:get-session", sessionId) as Promise<Conversation>,
  deleteSession: (sessionId) =>
    ipcRenderer.invoke("dowork:delete-session", sessionId) as Promise<Conversation>,
  sendMessage: (sessionId, text, attachmentIds) =>
    ipcRenderer.invoke("dowork:send-message", sessionId, text, attachmentIds) as Promise<void>,
  abort: (sessionId) => ipcRenderer.invoke("dowork:abort", sessionId) as Promise<void>,
  selectWorkspace: () =>
    ipcRenderer.invoke("dowork:select-workspace") as Promise<string | null>,
  selectAttachments: (maxCount) =>
    ipcRenderer.invoke("dowork:select-attachments", maxCount) as Promise<SelectedAttachment[]>,
  releaseAttachments: (attachmentIds) =>
    ipcRenderer.invoke("dowork:release-attachments", attachmentIds) as Promise<void>,
  saveSettings: (update: SettingsUpdate) =>
    ipcRenderer.invoke("dowork:save-settings", update) as Promise<AppSettings>,
  resolveApproval: (approvalId, approved) =>
    ipcRenderer.invoke(
      "dowork:resolve-approval",
      approvalId,
      approved,
    ) as Promise<void>,
  onRuntimeEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, runtimeEvent: RuntimeEvent) => {
      listener(runtimeEvent);
    };
    ipcRenderer.on("dowork:runtime-event", handler);
    return () => ipcRenderer.removeListener("dowork:runtime-event", handler);
  },
};

contextBridge.exposeInMainWorld("dowork", api);
