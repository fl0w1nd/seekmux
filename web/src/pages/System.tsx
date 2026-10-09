import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { useConfig } from "../lib/config";
import { PageHeader } from "../Shell";
import { useConfirm, useToast } from "../ui/overlays";
import { Button, Field, Input, Notice, NumberInput, Panel, Row, Switch, PasswordInput } from "../ui/primitives";

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
      <PageHeader title="系统" description="日志保留、自动熔断、出站网络、配置的备份与迁移，以及管理员密码。" />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="请求日志" description="日志和配置存在同一个 SQLite 文件里，每小时按下面的规则清理一次。" flush>
          <Row label="保留天数" hint="早于这个天数的日志会被删除">
            <NumberInput className="w-24" min={1} suffix="天" value={config.logs.retention_days} onChange={(v) => update((d) => void (d.logs.retention_days = Math.round(v)))} />
          </Row>
          <Row label="最多保留条数" hint="超出后从最旧的开始删除，用来限制数据库体积">
            <NumberInput className="w-32" min={100} suffix="条" value={config.logs.max_rows} onChange={(v) => update((d) => void (d.logs.max_rows = Math.round(v)))} />
          </Row>
          <Row label="记录返回内容" hint="保存每次调用返回给 Agent 的内容（截断到固定长度）。便于排查，但数据库会更大">
            <Switch checked={config.logs.capture_body} onCheckedChange={(v) => update((d) => void (d.logs.capture_body = v))} aria-label="记录返回内容" />
          </Row>
        </Panel>

        <Panel
          index="02"
          title="自动熔断"
          description="搜索、抓取的提供商和提取模型共用这一套规则：连续出问题的会被暂时跳过，请求直接交给下一家，不必每次都等它超时。深度研究的模型不参与。"
          flush
        >
          <Row label="启用自动熔断" hint="关闭后会立即恢复所有已熔断的提供商和模型">
            <Switch checked={config.breaker.enabled} onCheckedChange={(v) => update((d) => void (d.breaker.enabled = v))} aria-label="启用自动熔断" />
          </Row>
          <Row label="触发条件" hint="只统计超时、连不上、限流（429）、鉴权失败和 5xx；请求本身被拒（400、404）不算。中间成功一次就重新计数">
            <NumberInput className="w-24" min={10} suffix="秒内" disabled={!config.breaker.enabled} value={config.breaker.window_seconds} onChange={(v) => update((d) => void (d.breaker.window_seconds = Math.round(v)))} aria-label="统计窗口" />
            <span className="text-xs text-ink-3">连续失败</span>
            <NumberInput className="w-20" min={1} suffix="次" disabled={!config.breaker.enabled} value={config.breaker.failures} onChange={(v) => update((d) => void (d.breaker.failures = Math.round(v)))} aria-label="连续失败次数" />
          </Row>
          <Row label="禁用时长" hint="到期后放行试探：成功即恢复，再失败一次就重新禁用这么久。也可以在概览页手动恢复">
            <NumberInput className="w-24" min={5} suffix="秒" disabled={!config.breaker.enabled} value={config.breaker.cooldown_seconds} onChange={(v) => update((d) => void (d.breaker.cooldown_seconds = Math.round(v)))} />
          </Row>
        </Panel>

        <Panel index="03" title="出站网络" flush>
          <Row label="代理" hint="访问搜索、抓取和模型接口时使用。留空则直连">
            <Input mono className="w-72" value={config.network.proxy ?? ""} placeholder="http://127.0.0.1:7890" onChange={(e) => update((d) => void (d.network.proxy = e.target.value.trim() || undefined))} />
          </Row>
          <Row label="页面缓存" hint="抓到的页面会在内存中缓存一段时间，供同一页面的后续提问复用">
            <Button loading={clearCache.isPending} onClick={() => clearCache.mutate()}>
              清空缓存
            </Button>
          </Row>
        </Panel>

        <Panel index="04" title="配置文件" description="数据库是配置的唯一来源；YAML 用于备份、迁移和纳入版本管理。" flush>
          <Row label="导出为 YAML" hint="导出的文件包含明文 API key，请妥善保管">
            <a href="/api/config/export" download>
              <Button icon={<Download />} tabIndex={-1}>
                导出
              </Button>
            </a>
          </Row>
          <Row label="从 YAML 导入" hint="用文件内容整体替换当前配置并立即生效；文件里留空的密钥沿用现有的">
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
                  body: "当前配置会被整体替换。",
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

        <div className="tag px-1 normal-case">SeekMux {meta.version}</div>
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
    <Panel index="05" title="管理员密码">
      <form
        className="flex max-w-sm flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <Field label="当前密码">
          <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="新密码" hint="至少 10 个字符">
          <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="再输入一次" error={mismatch ? "两次输入不一致" : undefined}>
          <PasswordInput autoComplete="new-password" value={repeat} aria-invalid={mismatch} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        {change.error && <Notice tone="err">{change.error.message}</Notice>}
        <div>
          <Button type="submit" variant="primary" loading={change.isPending} disabled={!current || next.length < 10 || next !== repeat}>
            修改密码
          </Button>
        </div>
      </form>
    </Panel>
  );
}
