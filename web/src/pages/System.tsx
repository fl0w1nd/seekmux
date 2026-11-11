import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, Input, Notice, NumberInput, Panel, Row, Switch, PasswordInput } from "../ui/primitives";

export function SystemPage() {
  const { config, update, meta } = useConfig();
  const client = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const file = useRef<HTMLInputElement>(null);

  const importConfig = useMutation({
    mutationFn: api.importConfig,
    onSuccess: (saved) => {
      client.setQueryData(["config"], saved);
      void client.invalidateQueries({ queryKey: ["overview"] });
      toast("配置已导入并生效");
    },
    onError: (error) => toast(`导入失败：${error.message}`, "err"),
  });
  const clearCache = useMutation({
    mutationFn: api.clearCache,
    onSuccess: () => toast("页面缓存已清空"),
    onError: (error) => toast(error.message, "err"),
  });

  return (
    <>
      <PageHeader title="系统" />
      <div className="flex flex-col gap-3">
        <Panel title="请求日志" flush>
          <Row label="保留天数" hint="研究报告链接同期失效">
            <NumberInput className="w-24" min={1} suffix="天" value={config.logs.retention_days} onChange={(v) => update((d) => void (d.logs.retention_days = Math.round(v)))} />
          </Row>
          <Row label="最多保留条数">
            <NumberInput className="w-32" min={100} suffix="条" value={config.logs.max_rows} onChange={(v) => update((d) => void (d.logs.max_rows = Math.round(v)))} />
          </Row>
          <Row label="记录返回内容" info="在日志中保存响应正文，过长截断">
            <Switch checked={config.logs.capture_body} onCheckedChange={(v) => update((d) => void (d.logs.capture_body = v))} aria-label="记录返回内容" />
          </Row>
        </Panel>

        <Panel
          title="自动熔断"
          info="对搜索、抓取提供商与提取模型生效：连续失败达到阈值后暂时跳过，冷却期满放行一次试探请求"
          flush
        >
          <Row label="启用自动熔断" hint="关闭即恢复所有已熔断项">
            <Switch checked={config.breaker.enabled} onCheckedChange={(v) => update((d) => void (d.breaker.enabled = v))} aria-label="启用自动熔断" />
          </Row>
          <Row label="触发条件" info="只统计超时、连接失败、限流、鉴权失败和 5xx；成功一次即重新计数">
            <NumberInput className="w-24" min={10} suffix="秒内" disabled={!config.breaker.enabled} value={config.breaker.window_seconds} onChange={(v) => update((d) => void (d.breaker.window_seconds = Math.round(v)))} aria-label="统计窗口" />
            <span className="text-xs text-ink-3">连续失败</span>
            <NumberInput className="w-20" min={1} suffix="次" disabled={!config.breaker.enabled} value={config.breaker.failures} onChange={(v) => update((d) => void (d.breaker.failures = Math.round(v)))} aria-label="连续失败次数" />
          </Row>
          <Row label="冷却时长">
            <NumberInput className="w-24" min={5} suffix="秒" disabled={!config.breaker.enabled} value={config.breaker.cooldown_seconds} onChange={(v) => update((d) => void (d.breaker.cooldown_seconds = Math.round(v)))} />
          </Row>
        </Panel>

        <Panel title="网络" flush>
          <Row label="对外地址" hint="留空取请求到达的地址" info="研究报告链接与 OAuth 登录地址以此开头。Agent 经内网地址接入时需要填写。">
            <Input mono className="w-72" value={config.network.public_url ?? ""} placeholder="https://seekmux.example.com" onChange={(e) => update((d) => void (d.network.public_url = e.target.value.trim() || undefined))} />
          </Row>
          <Row label="OAuth 登录" hint="关闭后已签发的令牌立即失效">
            <Switch checked={!config.oauth.disabled} onCheckedChange={(on) => update((d) => void (d.oauth.disabled = on ? undefined : true))} aria-label="允许 MCP 客户端通过 OAuth 登录" />
          </Row>
          <Row label="出站代理">
            <Input mono className="w-72" value={config.network.proxy ?? ""} placeholder="http://127.0.0.1:7890" onChange={(e) => update((d) => void (d.network.proxy = e.target.value.trim() || undefined))} />
          </Row>
          <Row label="页面缓存">
            <Button loading={clearCache.isPending} onClick={() => clearCache.mutate()}>
              清空缓存
            </Button>
          </Row>
        </Panel>

        <Panel title="配置文件" flush>
          <Row label="导出为 YAML" hint="含明文 API Key">
            <a href="/api/config/export" download>
              <Button icon={<Download />} tabIndex={-1}>
                导出
              </Button>
            </a>
          </Row>
          <Row label="从 YAML 导入" hint="整体替换当前配置，留空的密钥保留现值">
            <input
              ref={file}
              type="file"
              accept=".yaml,.yml,text/yaml"
              className="hidden"
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (!picked) return;
                const ok = await confirm({
                  title: `导入 ${picked.name}？`,
                  body: "当前配置将被整体替换。",
                  confirm: "导入并替换",
                  danger: true,
                });
                if (ok) importConfig.mutate(await picked.text());
              }}
            />
            <Button icon={<Upload />} loading={importConfig.isPending} onClick={() => file.current?.click()}>
              选择文件
            </Button>
          </Row>
        </Panel>

        <PasswordPanel />

        <div className="num px-1 text-2xs text-ink-3">SeekMux {meta.version}</div>
      </div>
    </>
  );
}

function PasswordPanel() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setRepeat("");
      toast("密码已修改，其他设备上的登录已失效");
    },
  });
  const mismatch = repeat !== "" && repeat !== next;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        change.mutate();
      }}
    >
      <Panel
        title="管理员密码"
        flush
        actions={
          <Button size="sm" type="submit" variant="primary" loading={change.isPending} disabled={!current || next.length < 10 || next !== repeat}>
            修改密码
          </Button>
        }
      >
        <Row label="当前密码">
          <PasswordInput className="w-64 max-w-full" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} aria-label="当前密码" />
        </Row>
        <Row label="新密码" hint="至少 10 个字符">
          <PasswordInput className="w-64 max-w-full" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-label="新密码" />
        </Row>
        <Row label="确认新密码" hint={mismatch ? <span className="text-err">两次输入不一致</span> : undefined}>
          <PasswordInput className="w-64 max-w-full" autoComplete="new-password" value={repeat} aria-invalid={mismatch} onChange={(e) => setRepeat(e.target.value)} aria-label="确认新密码" />
        </Row>
        {change.error && (
          <div className="px-4 py-2.5">
            <Notice tone="err">{change.error.message}</Notice>
          </div>
        )}
      </Panel>
    </form>
  );
}
