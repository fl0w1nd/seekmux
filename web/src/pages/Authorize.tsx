import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type OAuthRequest, type Tool } from "../lib/api";
import { toolLabel } from "../lib/format";
import { Logo } from "../Shell";
import { Button, Empty, Notice, Spinner, Switch } from "../ui/primitives";

const tools: Tool[] = ["search", "dev_search", "fetch", "research"];

/** The request as the MCP client put it in this page's address. */
function requestFromLocation(): OAuthRequest {
  const query = new URLSearchParams(window.location.search);
  const field = (name: string) => query.get(name) ?? "";
  return {
    client_id: field("client_id"),
    redirect_uri: field("redirect_uri"),
    response_type: field("response_type"),
    code_challenge: field("code_challenge"),
    code_challenge_method: field("code_challenge_method"),
    scope: field("scope"),
    state: field("state"),
  };
}

/** Where an MCP client sends the admin to be let in: who is asking, and which tools it may call. */
export function AuthorizePage() {
  const [request] = useState(requestFromLocation);
  const prompt = useQuery({ queryKey: ["oauth", request], queryFn: () => api.oauthDescribe(request), retry: false, staleTime: Infinity });
  // The tools the admin ticked; until then, the ones the request came with.
  const [chosen, setChosen] = useState<Tool[] | null>(null);
  const decide = useMutation({
    mutationFn: (approve: boolean) => api.oauthDecide({ ...request, approve, scopes }),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });

  if (prompt.isPending) {
    return (
      <div className="grid h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (prompt.error) {
    return (
      <div className="grid h-dvh place-items-center px-4">
        <Empty title="无法处理这次授权请求">{prompt.error.message}</Empty>
      </div>
    );
  }
  // A request only the client can mend goes straight back to it.
  if (prompt.data.redirect) {
    window.location.replace(prompt.data.redirect);
    return null;
  }

  const scopes = chosen ?? prompt.data.scopes ?? [];
  const answered = decide.isSuccess;
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2.5">
          <Logo />
          <div>
            <div className="text-lg font-medium">SeekMux</div>
            <div className="tag">授权 MCP 客户端</div>
          </div>
        </div>
        <div className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-5">
          <div>
            <div className="text-base font-medium break-words">{prompt.data.client_name}</div>
            <div className="mt-1 text-sm text-ink-2">请求通过 MCP 调用本网关的工具。</div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">授权结果将发往</span>
            <div className="num rounded-ctl border border-line bg-sunken px-2.5 py-1.5 text-xs break-all text-ink-2">{prompt.data.redirect_uri}</div>
            <span className="text-xs text-ink-3">名称由客户端自行填写，不足为凭；请确认这个地址属于你正在连接的客户端。</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">可用工具</span>
            <ul className="rounded-ctl border border-line">
              {tools.map((tool) => (
                <li key={tool} className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 text-sm last:border-b-0">
                  <span>
                    {toolLabel[tool]} <span className="num text-xs text-ink-3">{tool}</span>
                  </span>
                  <Switch
                    checked={scopes.includes(tool)}
                    disabled={answered}
                    onCheckedChange={(on) => setChosen(tools.filter((t) => (t === tool ? on : scopes.includes(t))))}
                    aria-label={`允许调用 ${toolLabel[tool]}`}
                  />
                </li>
              ))}
            </ul>
          </div>
          <Notice>
            {prompt.data.key
              ? `该客户端此前已获授权，将沿用密钥「${prompt.data.key}」及其用量、限流与策略，可用工具以这次的选择为准。`
              : "授权后会在「密钥」页生成一把以该客户端命名的密钥，可在那里设置限流与策略，或随时吊销。"}
          </Notice>
          {decide.error && <Notice tone="err">{decide.error.message}</Notice>}
          {answered ? (
            <Notice tone="ok">已答复客户端。如果页面没有自动跳转，可以直接关闭。</Notice>
          ) : (
            <div className="flex justify-end gap-2">
              <Button disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                拒绝
              </Button>
              <Button variant="primary" loading={decide.isPending} disabled={scopes.length === 0} onClick={() => decide.mutate(true)}>
                授权
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
