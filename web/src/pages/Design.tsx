import { Inbox, Pencil, Play, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchText, fetchTrace, replay, researchTrace, searchTrace } from "../components/flow/fixtures";
import { FlowView } from "../components/flow/FlowView";
import { Timeline } from "../components/flow/Timeline";
import type { TraceNode } from "../lib/api";
import { TraceStore, useTraceStore } from "../lib/trace";
import { PageHeader } from "../components/PageHeader";
import { ChipInput, RateLimitInput } from "../ui/inputs";
import { Markdown } from "../ui/markdown";
import { Popover, useConfirm, useToast } from "../ui/overlays";
import {
  Badge,
  Button,
  CodeBlock,
  cx,
  Dot,
  Empty,
  Field,
  IconButton,
  Input,
  Kbd,
  Loading,
  Meter,
  Notice,
  NumberInput,
  Panel,
  Row,
  Section,
  Segmented,
  Select,
  Skeleton,
  Stat,
  StatGrid,
  State,
  Status,
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
  ["bg", "bg-bg", "画布、侧栏、目录"],
  ["surface", "bg-surface", "面板、输入框"],
  ["sunken", "bg-sunken", "代码、凹陷区"],
  ["overlay", "bg-overlay", "弹层"],
  ["thumb", "bg-thumb shadow-thumb", "滑块、开关钮"],
] as const;

const washes = [
  ["fill", "bg-fill", "悬停、次要按钮、轨道"],
  ["fill-strong", "bg-fill-strong", "按下、选中、骨架"],
  ["line", "border border-line", "分隔、容器边"],
  ["line-strong", "border border-line-strong", "输入框边"],
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

const charts = [
  ["chart-1", "bg-chart-1", "第一个系列"],
  ["chart-2", "bg-chart-2", "第二个系列"],
  ["chart-3", "bg-chart-3", "第三个系列"],
  ["chart-4", "bg-chart-4", "其余"],
] as const;

const roles = [
  ["t-title", "t-title", "22 / 30 · 600", "页面标题"],
  ["t-heading", "t-heading", "14 / 20 · 600", "面板、抽屉、对话框标题"],
  ["text-base", "text-base", "14 / 22", "正文"],
  ["text-sm", "text-sm", "13 / 20", "控件、表格、行"],
  ["text-xs", "text-xs text-ink-2", "12 / 18", "说明文字"],
  ["tag", "tag", "12 / 18 · 500", "分组名、列名、指标名"],
] as const;

const elevations = [
  ["shadow-panel", "shadow-panel", "页面底板"],
  ["shadow-raise", "shadow-raise", "可点击卡片悬停"],
  ["shadow-thumb", "shadow-thumb", "滑块、侧栏选中项"],
  ["shadow-overlay", "shadow-overlay", "弹层、对话框"],
] as const;

const radii = [
  ["rounded-tag", "rounded-tag", "4", "徽章、键帽、骨架"],
  ["rounded-thumb", "rounded-thumb", "5", "控件里的选项"],
  ["rounded-ctl", "rounded-ctl", "7", "控件、行组"],
  ["rounded-panel", "rounded-panel", "12", "面板、弹层"],
] as const;

const tones: Tone[] = ["neutral", "signal", "ok", "warn", "err", "info"];

function Swatch({ name, className, use }: { name: string; className: string; use: string }) {
  return (
    <div className="min-w-0">
      <div className={cx("h-12 rounded-ctl", className)} />
      <div className="num mt-1.5 text-xs">{name}</div>
      <div className="text-xs text-ink-3">{use}</div>
    </div>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-3 last:border-b-0">
      <span className="tag w-24 shrink-0">{label}</span>
      <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
const flows = {
  fetch: { label: "抓取", nodes: fetchTrace, text: fetchText, speed: 2 },
  search: { label: "搜索", nodes: searchTrace, text: {}, speed: 0.5 },
  research: { label: "研究", nodes: researchTrace, text: {}, speed: 6 },
};

/** A flow from sample data: as a stored call, or played again as a call in flight. */
function FlowSpecimen() {
  const [which, setWhich] = useState<keyof typeof flows>("fetch");
  const [run, setRun] = useState(0);
  const sample = flows[which];
  const store = useMemo(() => new TraceStore(), []);
  const live = useTraceStore(store);
  const [origin, setOrigin] = useState(0);
  // The sample on the clock of the replay: a long call is shortened, a short one drawn out.
  const scaled = useMemo<TraceNode[]>(
    () => sample.nodes.map((n) => ({ ...n, start_ms: Math.round(n.start_ms / sample.speed), duration_ms: n.duration_ms ? Math.max(1, Math.round(n.duration_ms / sample.speed)) : n.duration_ms })),
    [sample],
  );
  useEffect(() => {
    if (!run) return;
    store.reset();
    setOrigin(Date.now());
    const stop = replay(scaled, (node) => store.put(node));
    const end = setTimeout(() => setRun(0), scaled[0].duration_ms! + 400);
    return () => {
      stop();
      clearTimeout(end);
    };
  }, [run, scaled, store]);
  return (
    <Panel
      title="流程"
      description="一次调用怎么被判断和执行：顺序往下走，同时发生的并排；判断是一枚写着结论的药丸，耗时的调用是一张带状态、耗时和时间位置的卡片。虚线是没走通的分支。"
      flush
      actions={
        <>
          <Segmented
            size="sm"
            value={which}
            onChange={(v) => {
              setRun(0);
              setWhich(v);
            }}
            options={Object.entries(flows).map(([value, f]) => ({ value: value as keyof typeof flows, label: f.label }))}
          />
          <Button size="sm" icon={<RotateCcw />} onClick={() => setRun((n) => n + 1)}>
            按进行中重放
          </Button>
        </>
      }
    >
      {run ? (
        <FlowView key={`live${run}`} nodes={live.nodes} live origin={origin} className="min-h-96 overflow-hidden rounded-b-panel" />
      ) : (
        <FlowView key={which} nodes={sample.nodes} text={sample.text} className="overflow-hidden rounded-b-panel" />
      )}
    </Panel>
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
  const [choice, setChoice] = useState("b");
  const [model, setModel] = useState("");

  return (
    <>
      <PageHeader title="设计规范" description="Signal 的全部 token 与控件，规则见 web/DESIGN.md。" />
      <div className="flex flex-col gap-3">
        <Panel title="表面、线与填充" description="画布和侧栏在 bg 上，面板和输入框是最亮的 surface。线和填充是半透明的墨色，放在哪一层上都一样。">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {surfaces.map(([name, className, use]) => (
              <Swatch key={name} name={name} className={cx(className, name !== "thumb" && "border border-line")} use={use} />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {washes.map(([name, className, use]) => (
              <Swatch key={name} name={name} className={className} use={use} />
            ))}
          </div>
        </Panel>

        <Panel title="颜色" description="只有一个品牌色。状态色刻意避开它的色相，“成功”不会被读成“品牌”。">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            {accents.map(([name, className, use]) => (
              <Swatch key={name} name={name} className={className} use={use} />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {charts.map(([name, className, use]) => (
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

        <Panel title="字体" description="IBM Plex Sans 负责阅读，IBM Plex Mono 负责一切机器产生的内容：数字、ID、URL、密钥、模型名。强调靠字重，不靠加框。" flush>
          {roles.map(([name, className, size, use]) => (
            <div key={name} className="flex items-baseline gap-6 border-b border-line px-4 py-2.5">
              <span className="num w-20 shrink-0 text-xs text-ink-3">{name}</span>
              <span className="num hidden w-24 shrink-0 text-xs text-ink-3 sm:block">{size}</span>
              <span className={cx("min-w-0 flex-1 truncate", className)}>聚合搜索网关 Search gateway</span>
              <span className="hidden shrink-0 text-xs text-ink-3 md:block">{use}</span>
            </div>
          ))}
          <div className="flex items-baseline gap-6 border-b border-line px-4 py-2.5">
            <span className="num w-20 shrink-0 text-xs text-ink-3">num</span>
            <span className="num hidden w-24 shrink-0 text-xs text-ink-3 sm:block">mono</span>
            <span className="num min-w-0 flex-1 truncate">1,284 · 2.31s · 98.4% · smx_4f1a… · exa/claude-haiku</span>
          </div>
          <div className="flex items-baseline gap-6 px-4 py-2.5">
            <span className="num w-20 shrink-0 text-xs text-ink-3">caps</span>
            <span className="num hidden w-24 shrink-0 text-xs text-ink-3 sm:block">11 · mono</span>
            <span className="caps min-w-0 flex-1 truncate">POST · zh-CN · p95</span>
            <span className="hidden shrink-0 text-xs text-ink-3 md:block">只给拉丁字母的机器微标</span>
          </div>
        </Panel>

        <Panel title="形状与高度" description="四个圆角，四档阴影。阴影只有两层、很淡，用来把一张面板从画布上托起，不用来装饰。">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {radii.map(([name, className, px, use]) => (
              <div key={name} className="min-w-0">
                <div className={cx("h-12 bg-fill-strong", className)} />
                <div className="num mt-1.5 text-xs">
                  {name} <span className="text-ink-3">{px}px</span>
                </div>
                <div className="text-xs text-ink-3">{use}</div>
              </div>
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4 rounded-ctl bg-bg p-4 sm:grid-cols-4">
            {elevations.map(([name, className, use]) => (
              <div key={name} className="min-w-0">
                <div className={cx("h-14 rounded-panel bg-surface", className)} />
                <div className="num mt-2 text-xs">{name}</div>
                <div className="text-xs text-ink-3">{use}</div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="控件" description="控件 32px 高（紧凑处 28px）。按钮是填充的，不画边框；输入框白底细线，聚焦时一圈信号色光晕。" flush>
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
            <Button variant="primary" disabled>
              不可用
            </Button>
            <Button size="sm">紧凑</Button>
          </Specimen>
          <Specimen label="IconButton">
            <IconButton icon={<Pencil />} label="编辑" />
            <IconButton icon={<Trash2 />} label="删除" />
            <IconButton icon={<RotateCcw />} label="重试" size="sm" />
          </Specimen>
          <Specimen label="Input">
            <Input className="w-48" placeholder="占位文字" />
            <Input className="w-48" mono defaultValue="https://api.exa.ai" />
            <Input className="w-40" aria-invalid defaultValue="无效的值" />
            <NumberInput className="w-24" suffix="秒" value={count} onChange={setCount} />
          </Specimen>
          <Specimen label="Select">
            <Select className="w-36" value={choice} onChange={setChoice} options={[{ value: "a", label: "自动" }, { value: "b", label: "仅 Exa" }]} />
            <Select
              className="w-56"
              mono
              value={model}
              onChange={setModel}
              placeholder="选择模型"
              options={[
                { group: "anthropic", options: [{ value: "claude-haiku", label: "claude-haiku" }, { value: "claude-sonnet", label: "claude-sonnet" }] },
                { group: "openai", options: [{ value: "gpt-mini", label: "gpt-mini" }] },
              ]}
            />
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
            <div className="w-80 max-w-full min-w-0">
              <ChipInput value={domains} onChange={setDomains} max={5} placeholder="example.com" aria-label="示例域名" />
            </div>
          </Specimen>
          <Specimen label="Field">
            <Field label="字段名" className="w-64">
              <Input placeholder="示例值写在这里" />
            </Field>
            <Field label="带说明的字段" info="值本身之外值得知道的机制，放在 ⓘ 里。" className="w-64">
              <Input placeholder="值" />
            </Field>
            <Field label="出错的字段" error="哪里不对" className="w-64">
              <Input aria-invalid defaultValue="abc" />
            </Field>
          </Specimen>
          <Specimen label="Kbd">
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Kbd>Esc</Kbd> 关闭
            </span>
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 切换
            </span>
            <span className="flex items-center gap-1.5 text-xs text-ink-3">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd> 运行
            </span>
          </Specimen>
        </Panel>

        <Panel title="状态" description="状态永远是“点 + 字”，不单靠颜色。正常或中性的状态是 Status，没有底；Badge 留给分类和需要注意的问题。会呼吸的点只表示此刻正在发生的事。" flush>
          <Specimen label="Status">
            {tones.map((tone) => (
              <Status key={tone} tone={tone}>
                {tone}
              </Status>
            ))}
            <Status tone="signal" live>
              live
            </Status>
          </Specimen>
          <Specimen label="Badge">
            {tones.map((tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
            <Badge mono>v1.4.2</Badge>
          </Specimen>
          <Specimen label="State">
            <State tone="ok">可用</State>
            <State tone="signal" live>
              进行中
            </State>
            <State tone="warn">限流</State>
            <State tone="err">密钥被拒</State>
          </Specimen>
          <Specimen label="Dot">
            {tones.map((tone) => (
              <Dot key={tone} tone={tone} />
            ))}
          </Specimen>
          <Specimen label="Meter">
            <Meter used={4} limit={15} />
            <Meter used={15} limit={15} />
            <Meter used={130} limit={500} tone="ok" />
            <Meter used={0} limit={0} />
          </Specimen>
          <Specimen label="Notice">
            <div className="flex w-full flex-col gap-2">
              <Notice tone="warn">未配置提取模型，fetch 只返回原文。</Notice>
              <Notice tone="err">exa 的密钥被拒。</Notice>
            </div>
          </Specimen>
          <Specimen label="Feedback">
            <Button onClick={() => toast("配置已保存并生效")}>成功提示</Button>
            <Button onClick={() => toast("保存失败：exa 缺少 API Key", "err")}>错误提示</Button>
            <Button onClick={() => void confirm({ title: "清空全部日志？", body: "这个操作不能撤销。", confirm: "清空", danger: true })}>确认框</Button>
            <Popover trigger={<Button>浮层</Button>} className="w-72 p-3">
              <p className="text-sm">锚定在触发它的控件上的少量选项。</p>
            </Popover>
          </Specimen>
        </Panel>

        <Panel title="加载与空状态" description="加载中显示内容将占的形状，不在空白中间转圈；空状态只有一句标题，有事可做时加一个操作。">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-hidden rounded-ctl border border-line">
              <Loading rows={3} />
            </div>
            <div className="flex flex-col gap-3">
              <Skeleton className="h-6 w-1/3" />
              <Skeleton className="w-full" />
              <Skeleton className="w-4/5" />
              <Skeleton panel className="h-16" />
            </div>
          </div>
          <div className="mt-4 rounded-ctl bg-fill">
            <Empty icon={<Inbox />} title="还没有 API Key">
              <Button variant="primary" size="sm" icon={<Plus />}>
                新建
              </Button>
            </Empty>
          </div>
        </Panel>

        <Panel title="数据" description="关键数字用 Stat；设置用行，数据用表；一次调用里每一段的耗时排在同一条时间轴上。">
          <StatGrid className="grid-cols-2 lg:grid-cols-4">
            <Stat label="调用" value="1,284" detail="比昨天多 12%" />
            <Stat label="成功率" value="98.4" unit="%" tone="ok" />
            <Stat label="P95 耗时" value="2.31" unit="s" />
            <Stat label="失败" value="21" tone="err" detail="多数是 exa 限流" />
          </StatGrid>
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded-ctl border border-line">
              <Row label="设置项">
                <Switch defaultChecked aria-label="示例" />
              </Row>
              <Row label="数值设置" info="单位写在输入框内；值为 0 时显示含义。">
                <NumberInput className="w-24" suffix="秒" zero="不限" value={count} onChange={setCount} />
              </Row>
            </div>
            <div className="overflow-hidden rounded-ctl border border-line">
              <Timeline nodes={fetchTrace} />
            </div>
          </div>
          <CodeBlock copy className="mt-4">
            {'{\n  "queries": ["mcp streamable http"],\n  "search_engine": "auto"\n}'}
          </CodeBlock>
        </Panel>
        <Panel title="结构与内容" description="折叠组在标题行给出当前取值，收起也能读；标签页切换同一份数据的不同视图；Markdown 用于提供商和模型返回的长文本。">
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
                          流程
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

        <FlowSpecimen />
      </div>
    </>
  );
}
