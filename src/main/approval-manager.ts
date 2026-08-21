import type { BrowserWindow } from "electron";
import type { ApprovalRequest, RuntimeEvent } from "../shared/types";

interface PendingApproval {
  resolve: (approved: boolean) => void;
  sessionId: string;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  request(request: Omit<ApprovalRequest, "id">): Promise<boolean> {
    const id = crypto.randomUUID();
    const approval: ApprovalRequest = { id, ...request };

    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { resolve, sessionId: request.sessionId });
      this.send({ type: "approval_requested", approval });
    });
  }

  resolve(id: string, approved: boolean): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.resolve(approved);
    this.send({ type: "approval_resolved", approvalId: id });
  }

  rejectSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        this.resolve(id, false);
      }
    }
  }

  rejectAll(): void {
    for (const id of [...this.pending.keys()]) {
      this.resolve(id, false);
    }
  }

  private send(event: RuntimeEvent): void {
    this.getWindow()?.webContents.send("dowork:runtime-event", event);
  }
}
