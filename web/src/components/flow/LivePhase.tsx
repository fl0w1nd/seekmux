import { Fragment } from "react";
import type { ActiveNode, LiveCall, TraceNode } from "../../lib/api";
import { ProviderKind } from "../ProviderName";
import { titleOf } from "./wording";

function Doing({ node }: { node: ActiveNode }) {
  switch (node.kind) {
    case "attempt":
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          请求 <ProviderKind id={node.name ?? ""} icon="size-3" />
        </span>
      );
    case "llm":
    case "agent":
      return (
        <span className="min-w-0 truncate">
          模型 <span className="num">{node.name}</span> 在写
        </span>
      );
    case "step":
      return <span>模型在想下一步</span>;
    case "worker":
      return <span className="min-w-0 truncate">Worker {node.name} 在读页面</span>;
    case "query":
      return <span className="min-w-0 truncate">查询「{node.name}」</span>;
    case "call":
      return <span>准备中</span>;
    default:
      return <span className="min-w-0 truncate">{titleOf({ ...node, status: "running" } as TraceNode)}</span>;
  }
}

/** What a call in flight is doing at this moment, from the nodes it has running. */
export function LivePhase({ call, className }: { call: Pick<LiveCall, "active" | "step">; className?: string }) {
  const active = call.active ?? [];
  const shown = active.slice(0, 2);
  return (
    <span className={className ?? "inline-flex min-w-0 items-center gap-1.5"}>
      {call.step ? <span className="num shrink-0 text-ink-3">第 {call.step} 步</span> : null}
      {shown.length === 0 && !call.step && <span>准备中</span>}
      {shown.map((node, i) => (
        <Fragment key={node.id}>
          {(i > 0 || !!call.step) && <span className="shrink-0 text-ink-3">·</span>}
          <Doing node={node} />
        </Fragment>
      ))}
      {active.length > shown.length && <span className="num shrink-0 text-ink-3">+{active.length - shown.length}</span>}
    </span>
  );
}
