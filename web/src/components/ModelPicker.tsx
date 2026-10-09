import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { Link } from "wouter";
import type { Config, Model } from "../lib/api";
import { useConfig } from "../lib/config";
import { Badge, Button, Notice, Select } from "../ui/primitives";

/** Every configured model with the name of the provider it belongs to. */
export function allModels(config: Config): (Model & { provider: string })[] {
  return config.llm.providers.flatMap((p) => p.models.map((m) => ({ ...m, provider: p.name || p.id })));
}

function NoModels() {
  return (
    <Notice tone="warn">
      还没有可用的模型。先到{" "}
      <Link href="/models" className="text-ink underline underline-offset-2">
        模型接口
      </Link>{" "}
      添加接口并在它下面登记模型。
    </Notice>
  );
}

function Options({ models }: { models: (Model & { provider: string })[] }) {
  const providers = [...new Set(models.map((m) => m.provider))];
  return providers.map((provider) => (
    <optgroup key={provider} label={provider}>
      {models
        .filter((m) => m.provider === provider)
        .map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
    </optgroup>
  ));
}

/** Picks the one model a feature runs on. */
export function ModelSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { config } = useConfig();
  const models = allModels(config);
  if (models.length === 0) return <NoModels />;
  return (
    <Select className="max-w-sm" value={value} onChange={(e) => onChange(e.target.value)} aria-label="模型">
      <option value="">未选择</option>
      <Options models={models} />
    </Select>
  );
}

/**
 * The failover chain of a feature: models tried from the top. The limits
 * shown belong to the model and are edited where the model is defined.
 */
export function ModelChain({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { config } = useConfig();
  const models = allModels(config);
  if (models.length === 0) return <NoModels />;

  const unused = models.filter((m) => !value.includes(m.id));
  const move = (index: number, by: number) => {
    const next = [...value];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    onChange(next);
  };

  return (
    <div className="rounded-ctl border border-line">
      {value.length === 0 && <div className="border-b border-line px-3 py-3 text-xs text-ink-3">还没有指派模型。</div>}
      <ol>
        {value.map((id, index) => {
          const model = models.find((m) => m.id === id);
          return (
            <li key={id} className="flex items-center gap-3 border-b border-line px-3 py-2">
              <span className="num w-6 text-sm text-signal-text">{String(index + 1).padStart(2, "0")}</span>
              <span className="flex flex-col">
                <Button size="sm" variant="ghost" className="h-4" icon={<ArrowUp />} aria-label="上移" disabled={index === 0} onClick={() => move(index, -1)} />
                <Button size="sm" variant="ghost" className="h-4" icon={<ArrowDown />} aria-label="下移" disabled={index === value.length - 1} onClick={() => move(index, 1)} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="num truncate text-sm font-medium">{id}</div>
                <div className="tag normal-case">{model ? model.provider : "模型已不存在"}</div>
              </div>
              {index === 0 ? <Badge tone="signal">首选</Badge> : <Badge>备用</Badge>}
              <span className="num hidden w-24 text-right text-xs text-ink-3 sm:block">{model?.rate_limit || "不限流"}</span>
              <Button size="sm" variant="ghost" icon={<X />} aria-label={`移除 ${id}`} onClick={() => onChange(value.filter((v) => v !== id))} />
            </li>
          );
        })}
      </ol>
      <div className="flex items-center gap-2 px-3 py-2">
        <Plus className="size-3.5 text-ink-3" />
        <Select
          className="w-64"
          value=""
          disabled={unused.length === 0}
          aria-label="添加模型"
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
        >
          <option value="">{unused.length === 0 ? "所有模型都已在链中" : value.length === 0 ? "选择模型" : "添加备用模型"}</option>
          <Options models={unused} />
        </Select>
      </div>
    </div>
  );
}
