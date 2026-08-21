import { FilePenLine, ShieldCheck } from "lucide-react";
import type { ApprovalRequest } from "../../../shared/types";

interface ApprovalCardProps {
  approval: ApprovalRequest;
  onNotice: (message: string) => void;
}

export function ApprovalCard({ approval, onNotice }: ApprovalCardProps) {
  const resolve = async (approved: boolean) => {
    try {
      await window.dowork.resolveApproval(approval.id, approved);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "无法提交操作确认。");
    }
  };

  return (
    <section className="approval-card" aria-label="敏感操作确认">
      <div className="approval-icon">
        <ShieldCheck aria-hidden="true" size={19} />
      </div>
      <div className="approval-copy">
        <h3>{approval.title}</h3>
        <p>{approval.description}</p>
        <code>
          <FilePenLine aria-hidden="true" size={14} />
          {approval.path}
        </code>
      </div>
      <div className="approval-actions">
        <button className="button button--secondary" type="button" onClick={() => resolve(false)}>
          拒绝
        </button>
        <button className="button button--primary" type="button" onClick={() => resolve(true)}>
          允许一次
        </button>
      </div>
    </section>
  );
}
