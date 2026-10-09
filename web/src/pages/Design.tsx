import { Play, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Waterfall } from "../components/Waterfall";
import { PageHeader } from "../Shell";
import { ChipInput, RateLimitInput } from "../ui/inputs";
import { Markdown } from "../ui/markdown";
import { useConfirm, useToast } from "../ui/overlays";
import {
  Badge,
  Button,
  CodeBlock,
  cx,
  Dot,
  Field,
  Input,
  Meter,
  Notice,
  NumberInput,
  Panel,
  Row,
  Section,
  Segmented,
  Select,
  Switch,
  TabList,
  TabPanel,
  Tabs,
  type Tone,
} from "../ui/primitives";

const sampleMarkdown = `## Streamable HTTP

服务端提供**一个** HTTP 端点，同时支持 \`POST\` 与 \`GET\`。详见 [规范](https://modelcontextprotocol.io)。

- 每个 JSON-RPC 消息是一次 POST
- 响应可以是 JSON，也可以是 SSE 流

| 方法 | 用途 |
| --- | --- |
| POST | 发送请求 |
| GET | 打开 SSE 流 |
`;

const surfaces = [
  ["bg", "bg-bg", "页面底色"],
  ["surface", "bg-surface", "面板"],
  ["raised", "bg-raised", "悬停、选中"],
  ["sunken", "bg-sunken", "输入框、代码"],
  ["overlay", "bg-overlay", "弹层"],
] as const;

const inks = [
  ["ink", "text-ink", "正文与标题"],
  ["ink-2", "text-ink-2", "次要文字"],
  ["ink-3", "text-ink-3", "说明、占位、标签"],
] as const;

const accents = [
  ["signal", "bg-signal", "主操作、“正在发生”"],
  ["ok", "bg-ok", "成功、可用"],
  ["warn", "bg-warn", "限流、需要注意"],
  ["err", "bg-err", "失败、破坏性操作"],
  ["info", "bg-info", "中性提示、缓存"],
] as const;

const scale = [
  ["text-2xl", "28 / 34", "关键数字"],
  ["text-xl", "20 / 28", "页面标题"],
  ["text-lg", "16 / 24", "强调段落"],
  ["text-base", "14 / 22", "正文、面板标题"],
  ["text-sm", "13 / 20", "控件、表格"],
  ["text-xs", "12 / 18", "说明文字"],
  ["text-2xs", "11 / 16", "标签（tag）"],
] as const;

const tones: Tone[] = ["neutral", "signal", "ok", "warn", "err", "info"];

function Swatch({ name, className, use }: { name: string; className: string; use: string }) {
  return (
    <div className="min-w-0">
      <div className={cx("h-12 rounded-ctl border border-line", className)} />
      <div className="num mt-1.5 text-xs">{name}</div>
      <div className="text-xs text-ink-3">{use}</div>
    </div>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
      <span className="tag w-24 shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** The living reference of the Signal design system: every token and component, rendered. */
export function DesignPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [segment, setSegment] = useState("a");
  const [on, setOn] = useState(true);
  const [count, setCount] = useState(15);
  const [limit, setLimit] = useState("15/m");
  const [domains, setDomains] = useState(["github.com", "docs.python.org"]);
  const [tab, setTab] = useState("result");

  return (
    <>
      <PageHeader title="设计规范" description="Signal：SeekMux 的界面系统。这一页用真实组件渲染全部 token 与控件，改动设计时以这里为准；规则见 web/DESIGN.md。" />
      <div className="flex flex-col gap-4">
        <Panel index="01" title="表面与线" description="层级靠明度差和 1px 线表达，不用阴影；阴影只留给真正浮起的弹层。">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {surfaces.map(([name, className, use]) => (
              <Swatch key={name} name={name} className={className} use={use} />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div>
              <div className="h-12 rounded-ctl border border-line" />
              <div className="num mt-1.5 text-xs">line</div>
              <div className="text-xs text-ink-3">分隔、容器边</div>
            </div>
            <div>
              <div className="h-12 rounded-ctl border border-line-strong" />
              <div className="num mt-1.5 text-xs">line-strong</div>
              <div className="text-xs text-ink-3">控件边、弹层边</div>
            </div>
          </div>
        </Panel>

        <Panel index="02" title="颜色" description="只有一个品牌色。状态色刻意避开它的色相，“成功”不会被读成“品牌”。">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {accents.map(([name, className, use]) => (
              <Swatch key={name} name={name} className={className} use={use} />
            ))}
          </div>
          <div className="mt-5 flex flex-col gap-1.5">
            {inks.map(([name, className, use]) => (
              <div key={name} className="flex items-baseline gap-4">
                <span className="num w-16 text-xs text-ink-3">{name}</span>
                <span className={cx("text-base", className)}>{use} · The quick brown fox 0123456789</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel index="03" title="字体" description="IBM Plex Sans 负责阅读，IBM Plex Mono 负责一切机器产生的内容：数字、ID、URL、密钥、模型名。" flush>
          {scale.map(([className, size, use]) => (
            <div key={className} className="flex items-baseline gap-6 border-b border-line px-4 py-2.5 last:border-b-0">
              <span className="num w-20 shrink-0 text-xs text-ink-3">{className.slice(5)}</span>
              <span className="num w-16 shrink-0 text-xs text-ink-3">{size}</span>
              <span className={cx("min-w-0 flex-1 truncate", className)}>聚合搜索网关 Search gateway</span>
              <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{use}</span>
            </div>
          ))}
          <div className="flex items-baseline gap-6 px-4 py-2.5">
            <span className="num w-20 shrink-0 text-xs text-ink-3">num</span>
            <span className="num w-16 shrink-0 text-xs text-ink-3">mono</span>
            <span className="num flex-1">1,284 · 2.31s · 98.4% · smx_4f1a… · exa/claude-haiku</span>
          </div>
          <div className="flex items-baseline gap-6 border-t border-line px-4 py-2.5">
            <span className="num w-20 shrink-0 text-xs text-ink-3">tag</span>
            <span className="num w-16 shrink-0 text-xs text-ink-3">mono caps</span>
            <span className="tag flex-1">P95 latency · 01 · 上游调用</span>
          </div>
        </Panel>

        <Panel index="04" title="控件" description="所有控件 32px 高（紧凑处 28px），圆角 5px；容器圆角 10px。只有这两个圆角。" flush>
          <Specimen label="Button">
            <Button variant="primary" icon={<Play />}>
              主操作
            </Button>
            <Button icon={<Plus />}>次要</Button>
            <Button variant="ghost">幽灵</Button>
            <Button variant="danger" icon={<Trash2 />}>
              危险
            </Button>
            <Button loading>进行中</Button>
            <Button disabled>不可用</Button>
            <Button size="sm">紧凑</Button>
            <Button icon={<Plus />} aria-label="添加" />
          </Specimen>
          <Specimen label="Input">
            <Input className="w-48" placeholder="占位文字" />
            <Input className="w-48" mono defaultValue="https://api.exa.ai" />
            <Input className="w-40" aria-invalid defaultValue="无效的值" />
            <Select className="w-36" defaultValue="b">
              <option value="a">自动</option>
              <option value="b">仅 Exa</option>
            </Select>
            <NumberInput className="w-24" suffix="秒" value={count} onChange={setCount} />
          </Specimen>
          <Specimen label="Choice">
            <Switch checked={on} onCheckedChange={setOn} aria-label="示例开关" />
            <Segmented
              value={segment}
              onChange={setSegment}
              options={[
                { value: "a", label: "1 小时" },
                { value: "b", label: "24 小时" },
                { value: "c", label: "7 天" },
              ]}
            />
          </Specimen>
          <Specimen label="Rate limit">
            <RateLimitInput value={limit} onChange={setLimit} />
          </Specimen>
          <Specimen label="Chips">
            <div className="w-80">
              <ChipInput value={domains} onChange={setDomains} max={5} placeholder="example.com" aria-label="示例域名" />
            </div>
          </Specimen>
          <Specimen label="Field">
            <Field label="字段名" hint="一句话说明它影响什么" className="w-64">
              <Input placeholder="值" />
            </Field>
            <Field label="出错的字段" error="说明哪里不对、怎么改" className="w-64">
              <Input aria-invalid defaultValue="abc" />
            </Field>
          </Specimen>
        </Panel>

        <Panel index="05" title="状态" description="状态永远是“点 + 字”，不单靠颜色。会呼吸的点只表示此刻正在发生的事。" flush>
          <Specimen label="Dot">
            {tones.map((tone) => (
              <span key={tone} className="flex items-center gap-2 text-xs text-ink-2">
                <Dot tone={tone} />
                {tone}
              </span>
            ))}
            <span className="flex items-center gap-2 text-xs text-ink-2">
              <Dot tone="signal" live />
              live
            </span>
          </Specimen>
          <Specimen label="Badge">
            {tones.map((tone) => (
              <Badge key={tone} tone={tone} dot={tone !== "neutral"}>
                {tone}
              </Badge>
            ))}
          </Specimen>
          <Specimen label="Meter">
            <Meter used={4} limit={15} />
            <Meter used={15} limit={15} />
            <Meter used={130} limit={500} />
            <Meter used={0} limit={0} />
          </Specimen>
          <Specimen label="Notice">
            <div className="flex w-full flex-col gap-2">
              <Notice tone="info">提示：解释一个不明显的行为。</Notice>
              <Notice tone="warn">注意：功能可用，但结果会打折扣。</Notice>
              <Notice tone="err">错误：说明发生了什么，以及怎么恢复。</Notice>
            </div>
          </Specimen>
          <Specimen label="Feedback">
            <Button onClick={() => toast("配置已保存并生效")}>成功提示</Button>
            <Button onClick={() => toast("保存失败：exa 缺少 API key", "err")}>错误提示</Button>
            <Button onClick={() => void confirm({ title: "清空全部日志？", body: "这个操作不能撤销。", confirm: "清空", danger: true })}>确认框</Button>
          </Specimen>
        </Panel>

        <Panel index="06" title="数据" description="设置用行，数据用表；一次调用背后的上游请求用瀑布图。">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-ctl border border-line">
              <Row label="设置项" hint="左边说明是什么，右边是它的控件">
                <Switch defaultChecked aria-label="示例" />
              </Row>
              <Row label="数值设置" hint="单位写在输入框内">
                <NumberInput className="w-24" suffix="秒" value={count} onChange={setCount} />
              </Row>
            </div>
            <Waterfall
              total={4200}
              attempts={[
                { kind: "fetch", provider: "jina", status: "error", start_ms: 0, duration_ms: 1400, http_status: 429, error: "rate limited" },
                { kind: "fetch", provider: "firecrawl", status: "ok", start_ms: 1400, duration_ms: 1900, http_status: 200 },
                { kind: "fetch", provider: "tavily", status: "canceled", start_ms: 2400, duration_ms: 900 },
                { kind: "llm", provider: "extract/haiku", status: "ok", start_ms: 3300, duration_ms: 900 },
              ]}
            />
          </div>
          <CodeBlock copy className="mt-4">
            {'{\n  "queries": ["mcp streamable http"],\n  "search_engine": "auto"\n}'}
          </CodeBlock>
        </Panel>

        <Panel index="07" title="结构与内容" description="折叠组在标题行给出当前取值，收起也能读；标签页切换同一份数据的不同视图；Markdown 用于提供商和模型返回的长文本。">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-hidden rounded-ctl border border-line [&>*:first-child]:border-t-0">
              <Section title="数量与时间" summary="每条 5 个 · 不限" defaultOpen>
                <span className="text-xs text-ink-3">展开后是这一组的控件。</span>
              </Section>
              <Section title="域名过滤" summary="只看 2 个">
                <span className="text-xs text-ink-3">收起时只看标题行的摘要。</span>
              </Section>
            </div>
            <div className="rounded-ctl border border-line">
              <Tabs value={tab} onChange={setTab}>
                <TabList
                  tabs={[
                    { value: "result", label: "结果" },
                    {
                      value: "trace",
                      label: (
                        <>
                          调用链<span className="num text-xs text-ink-3">2</span>
                          <Dot tone="warn" />
                        </>
                      ),
                    },
                    { value: "code", label: "代码" },
                  ]}
                />
                <TabPanel value="result" className="p-4 text-xs text-ink-3">
                  标签上可以带数量和状态点。
                </TabPanel>
                <TabPanel value="trace" className="p-4 text-xs text-ink-3">
                  第二个视图。
                </TabPanel>
                <TabPanel value="code" className="p-4 text-xs text-ink-3">
                  第三个视图。
                </TabPanel>
              </Tabs>
            </div>
          </div>
          <div className="mt-4 rounded-ctl border border-line px-5 py-4">
            <Markdown>{sampleMarkdown}</Markdown>
          </div>
        </Panel>
      </div>
    </>
  );
}
