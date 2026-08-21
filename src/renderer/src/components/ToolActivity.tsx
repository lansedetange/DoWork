import {
  Brain,
  Check,
  Circle,
  Clock3,
  FilePenLine,
  FileSearch,
  Files,
  Globe2,
  LoaderCircle,
  Newspaper,
  ScanSearch,
  Trash2,
  X,
} from "lucide-react";
import type { ToolTranscriptItem } from "../../../shared/types";

const iconByTool = {
  list_files: Files,
  read_file: FileSearch,
  write_file: FilePenLine,
  edit_file: FilePenLine,
  delete_file: Trash2,
  web_search: Globe2,
  news_search: Newspaper,
  read_webpage: Globe2,
  analyze_media: ScanSearch,
  read_memory: Brain,
  remember: Brain,
  replace_memory: Brain,
  schedule_news_digest: Clock3,
  list_scheduled_tasks: Clock3,
  remove_scheduled_task: Clock3,
};

export function ToolActivity({ item }: { item: ToolTranscriptItem }) {
  const ToolIcon = iconByTool[item.toolName as keyof typeof iconByTool] ?? FilePenLine;
  const running = item.status === "running" || item.status === "waiting";
  const failed = item.status === "error" || item.status === "denied";

  return (
    <div className={`tool-activity tool-activity--${item.status}`}>
      <div className="tool-rail-marker">
        {running ? (
          <LoaderCircle aria-hidden="true" size={15} />
        ) : failed ? (
          <X aria-hidden="true" size={14} />
        ) : item.status === "done" ? (
          <Check aria-hidden="true" size={14} />
        ) : (
          <Circle aria-hidden="true" size={12} />
        )}
      </div>
      <div className="tool-card">
        <div className="tool-icon"><ToolIcon aria-hidden="true" size={17} /></div>
        <div className="tool-details">
          <strong>{item.label}</strong>
          {item.path ? <code>{item.path}</code> : null}
          {item.summary && failed ? <p>{item.summary}</p> : null}
        </div>
        <span className="tool-state">
          {item.status === "running"
            ? "执行中"
            : item.status === "waiting"
              ? "等待确认"
              : item.status === "done"
                ? "完成"
                : item.status === "denied"
                  ? "已拒绝"
                  : "失败"}
        </span>
      </div>
    </div>
  );
}
