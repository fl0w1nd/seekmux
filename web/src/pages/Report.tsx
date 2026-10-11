import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { api, APIError, type PublicReport } from "../lib/api";
import { dateTime } from "../lib/format";
import { Logo, useTheme } from "../Shell";
import { Markdown } from "../ui/markdown";
import { CopyButton, cx, Dot, Notice, Segmented, Spinner } from "../ui/primitives";

/** The width the page is laid out in, shared by its bands. */
const column = "mx-auto w-full max-w-[84rem] px-5 sm:px-8 lg:px-12";

/**
 * The report of a research task, for whoever was given its link. It stands
 * outside the console: no session, no navigation, and nothing of the run but
 * what a reader of the report needs.
 */
export function ReportPage({ id }: { id: string }) {
  const query = useQuery({
    queryKey: ["report", id],
    queryFn: () => api.report(id),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });
  const report = query.data;
  const heading = report ? split(report).title : "";
  useEffect(() => {
    if (!heading) return;
    document.title = `${heading.length > 60 ? `${heading.slice(0, 60)}…` : heading} · SeekMux`;
    return () => {
      document.title = "SeekMux";
    };
  }, [heading]);

  if (report?.status === "done") return <Document report={report} />;
  if (report?.status === "running") {
    return (
      <Message
        tag={
          <span className="flex items-center gap-2 text-signal-text">
            <Dot tone="signal" live />
            研究进行中
          </span>
        }
        title={report.question}
      >
        Agent 正在检索并阅读资料，通常需要几分钟。报告写完后，本页会自动显示全文，无需刷新。
      </Message>
    );
  }
  if (report) {
    return (
      <Message tag="深度研究报告" title="这次研究没有生成报告">
        {report.status === "canceled" ? "研究在完成前被停止。" : "研究在完成前中断。"}请向发来链接的人确认，或重新发起一次研究。
      </Message>
    );
  }
  if (query.isPending) {
    return (
      <div className="grid min-h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  const gone = query.error instanceof APIError && query.error.status === 404;
  return (
    <Message tag="深度研究报告" title={gone ? "报告不存在，或已过期" : "报告暂时无法读取"}>
      {gone ? "报告只保留一段时间，到期后链接随之失效。请确认链接完整，或向发来链接的人索取新的报告。" : `${query.error?.message ?? "未知错误"}。请稍后刷新重试。`}
    </Message>
  );
}

/* ---------- Text ---------- */

/** The report's own title, when it opens with one, and the rest of it. */
function split(report: PublicReport): { title: string; body: string; own: boolean } {
  const [, own, rest] = /^\s*#[ \t]+([^\n]+?)[ \t]*#*[ \t]*(?:\n([\s\S]*))?$/.exec(report.report) ?? [];
  if (own) return { title: own.replace(/[*_`]/g, ""), body: rest ?? "", own: true };
  return { title: report.question, body: report.report, own: false };
}

/** How wide a line of text sets: a CJK character takes the room of two Latin ones. */
function width(text: string): number {
  let n = 0;
  for (const char of text) n += char.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return n;
}

function parts(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ""), path: decodeURI(u.pathname + u.search).replace(/\/$/, "") };
  } catch {
    return { host: url, path: "" };
  }
}

/** A URL short enough to stand in a sentence: the site and the end of the path. */
function brief(url: string): string {
  const { host, path } = parts(url);
  if (path.length <= 26) return host + path;
  return `${host}/…${path.slice(-20)}`;
}

/** Minutes and seconds, the way a stopwatch shows them. */
function stopwatch(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// A link written out as its own address is a citation: it is set as a short
// marker, since a sentence that carries three full URLs can no longer be read.
const overrides: Components = {
  a: ({ href, children }) => {
    const cited = typeof href === "string" && /^https?:\/\//.test(href) && children === href;
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" title={cited ? href : undefined} className={cited ? "md-cite" : undefined}>
        {cited ? brief(href) : children}
      </a>
    );
  },
};

/* ---------- Frame ---------- */

function Bar({ children }: { children?: ReactNode }) {
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex h-16 items-center gap-2.5">
      <Logo className="size-7" />
      <div className="leading-tight">
        <div className="font-medium">SeekMux</div>
        <div className="tag whitespace-nowrap normal-case max-sm:hidden">deep research</div>
      </div>
      <div className="ml-auto flex items-center gap-1">
        {children}
        <div className="ml-2">
          <Segmented
            size="sm"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: <Monitor aria-label="跟随系统" /> },
              { value: "light", label: <Sun aria-label="浅色" /> },
              { value: "dark", label: <Moon aria-label="深色" /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/** The page when there is no report to show: one statement, set as large as a report's title. */
function Message({ tag, title, children }: { tag: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div aria-hidden className="report-backdrop absolute inset-0" />
      <div className={cx(column, "relative flex flex-1 flex-col")}>
        <Bar />
        <main className="flex flex-1 flex-col justify-center pt-10 pb-32">
          <div className="tag">{tag}</div>
          <Title text={title} className="mt-5" />
          <p className="mt-6 max-w-xl text-lg text-ink-2">{children}</p>
        </main>
      </div>
    </div>
  );
}

/** The title of the page, sized by how much there is of it; a very long one folds. */
function Title({ text, className }: { text: string; className?: string }) {
  const n = width(text);
  const long = n > 260;
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <h1
        className={cx(
          "max-w-5xl font-medium tracking-tight text-pretty whitespace-pre-line text-ink",
          n <= 44 ? "text-3xl lg:text-4xl" : n <= 120 ? "text-2xl lg:text-3xl" : "text-xl lg:text-2xl",
          long && !open && "line-clamp-4",
        )}
      >
        {text}
      </h1>
      {long && <Fold open={open} onToggle={() => setOpen(!open)} />}
    </div>
  );
}

function Fold({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="mt-2 text-xs text-ink-3 underline underline-offset-2 hover:text-ink">
      {open ? "收起" : "展开全文"}
    </button>
  );
}

/* ---------- The report ---------- */

interface Heading {
  id: string;
  text: string;
  /** 0 for a section, 1 for a part of one. */
  depth: number;
}

function Document({ report }: { report: PublicReport }) {
  const { title, body, own } = split(report);
  const article = useRef<HTMLElement>(null);
  const [toc, setToc] = useState<Heading[]>([]);
  const [active, setActive] = useState("");
  const [progress, setProgress] = useState(0);
  const [asked, setAsked] = useState(false);

  // The contents are read off the rendered report, whose headings get an id to jump to.
  useEffect(() => {
    const nodes = [...(article.current?.querySelectorAll<HTMLElement>(".md :is(h1, h2, h3)") ?? [])];
    const top = Math.min(...nodes.map((node) => Number(node.tagName[1])));
    const found = nodes.map((node, i) => {
      node.id = `s${i + 1}`;
      return { id: node.id, text: node.textContent ?? "", depth: Number(node.tagName[1]) - top };
    });
    setToc(found.filter((heading) => heading.depth < 2));
  }, [body]);

  useEffect(() => {
    const follow = () => {
      const span = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(span > 0 ? Math.min(1, window.scrollY / span) : 0);
      let current = "";
      for (const heading of toc) {
        const node = document.getElementById(heading.id);
        if (node && node.getBoundingClientRect().top <= 140) current = heading.id;
      }
      setActive(current);
    };
    follow();
    window.addEventListener("scroll", follow, { passive: true });
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow);
      window.removeEventListener("resize", follow);
    };
  }, [toc]);

  const sites = new Set(report.read.map((url) => parts(url).host)).size;
  const figures: { label: string; value: ReactNode; unit?: string; foot: string }[] = [
    { label: "检索", value: report.searches, unit: "次", foot: "换用不同措辞的搜索" },
    { label: "阅读", value: report.read.length, unit: "页", foot: "打开并读过正文的页面" },
    { label: "来源", value: sites, unit: "个站点", foot: "上述页面所属的站点" },
    { label: "用时", value: stopwatch(report.finished_at - report.created_at), foot: `完成于 ${dateTime(report.finished_at).slice(5, 16)}` },
  ];

  return (
    <div className="min-h-screen">
      {/* How far into the page the reader is. */}
      <div aria-hidden className="fixed inset-x-0 top-0 z-40 h-0.5">
        <div className="h-full origin-left bg-signal-text" style={{ transform: `scaleX(${progress})` }} />
      </div>

      <header className="relative overflow-hidden border-b border-line">
        <div aria-hidden className="report-backdrop absolute inset-0" />
        <div className={cx(column, "relative")}>
          <Bar>
            <CopyButton text={window.location.href} label="复制链接" />
            <span className="max-sm:hidden">
              <CopyButton text={report.report} label="复制 Markdown" />
            </span>
          </Bar>
          <div className="pt-14 pb-12 lg:pt-24 lg:pb-16">
            <div className="tag flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-signal-text">深度研究报告</span>
              <span>{dateTime(report.finished_at).slice(0, 10)}</span>
            </div>
            <Title text={title} className="mt-5" />
            {own && (
              <div className="mt-8 max-w-3xl border-l-2 border-line-strong pl-4">
                <div className="tag">研究问题</div>
                <p className={cx("mt-1.5 text-lg whitespace-pre-line text-ink-2", !asked && "line-clamp-3")}>{report.question}</p>
                {width(report.question) > 220 && <Fold open={asked} onToggle={() => setAsked(!asked)} />}
              </div>
            )}
          </div>
          <dl className="mb-12 grid grid-cols-2 gap-px overflow-hidden rounded-panel border border-line bg-line lg:grid-cols-4">
            {figures.map((figure) => (
              <div key={figure.label} className="flex min-w-0 flex-col gap-1.5 bg-surface px-5 py-4">
                <dt className="tag">{figure.label}</dt>
                <dd className="num flex items-baseline gap-1.5">
                  <span className="text-2xl font-medium text-ink lg:text-3xl">{figure.value}</span>
                  {figure.unit && <span className="font-sans text-sm text-ink-3">{figure.unit}</span>}
                </dd>
                <dd className="truncate text-xs text-ink-3">{figure.foot}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div className={cx(column, "grid gap-x-14 py-12 lg:grid-cols-[13rem_minmax(0,1fr)] lg:py-16 xl:grid-cols-[13rem_minmax(0,46rem)_minmax(0,1fr)]")}>
        <aside className="max-lg:hidden">
          {toc.length > 1 && (
            <nav aria-label="目录" className="sticky top-10 max-h-[calc(100vh-5rem)] overflow-y-auto pr-2">
              <div className="tag mb-3">目录</div>
              <ol>
                {toc.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      aria-current={heading.id === active ? "location" : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(heading.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                      className={cx(
                        "block border-l py-1.5 leading-5 transition-colors",
                        heading.depth === 0 ? "pl-3.5 text-sm" : "pl-7 text-xs",
                        heading.id === active ? "border-signal-text text-ink" : "border-line text-ink-3 hover:border-line-strong hover:text-ink-2",
                      )}
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </aside>

        <article ref={article} className="min-w-0">
          {(report.cut_short || report.unread.length > 0) && (
            <div className="mb-10 flex flex-col gap-2">
              {report.cut_short && <Notice tone="warn">研究预算在 Agent 查证完毕之前用尽，这份报告基于当时已收集到的材料写成，可能不完整。</Notice>}
              {report.unread.length > 0 && (
                <Notice tone="warn">
                  报告引用了 {report.unread.length} 个 Agent 没有读过正文的链接，相关论断未经原文核对：
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {report.unread.map((url) => (
                      <li key={url} className="num break-all">
                        {url}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
            </div>
          )}
          <Markdown className="md-report" overrides={overrides}>
            {body}
          </Markdown>
        </article>

        <aside className="max-xl:mt-14 lg:max-xl:col-start-2">
          <div className="rounded-panel border border-line xl:sticky xl:top-10">
            <dl className="grid max-xl:sm:grid-cols-3 max-xl:sm:[&>div]:border-b-0">
              <Fact label="生成时间">{dateTime(report.finished_at).slice(0, 16)}</Fact>
              <Fact label="链接有效期至">{dateTime(report.expires_at).slice(0, 10)}</Fact>
              <Fact label="报告编号">{report.id.slice(0, 11)}</Fact>
            </dl>
            <p className="border-t border-line px-4 py-3 text-xs text-ink-3">本报告由 AI 研究 Agent 自动检索、阅读并撰写。数字、版本与结论请对照文中出处核实。</p>
          </div>
        </aside>
      </div>

      {report.read.length > 0 && (
        <section className="border-t border-line bg-surface">
          <div className={cx(column, "py-14 lg:py-20")}>
            <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
              <div>
                <div className="tag text-signal-text">来源</div>
                <h2 className="mt-2 text-2xl font-medium tracking-tight">
                  Agent 读过的 <span className="num">{report.read.length}</span> 个页面
                </h2>
              </div>
              <p className="max-w-md text-sm text-ink-3">按阅读顺序排列。标有「已引用」的页面在报告中被直接引用，其余用于交叉核对或了解背景。</p>
            </div>
            <ol className="mt-8 grid border-t border-l border-line sm:grid-cols-2 xl:grid-cols-3">
              {report.read.map((url, i) => {
                const { host, path } = parts(url);
                return (
                  <li key={url} className="min-w-0 border-r border-b border-line">
                    <a href={url} target="_blank" rel="noreferrer noopener" className="group flex h-full gap-3.5 px-4 py-3.5 transition-colors hover:bg-raised/60">
                      <span className="num pt-0.5 text-xs text-signal-text">{String(i + 1).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2.5">
                          <span className="truncate font-medium text-ink">{host}</span>
                          {report.report.includes(url) && (
                            <span className="flex shrink-0 items-center gap-1.5 text-2xs text-ink-3">
                              <Dot tone="ok" />
                              已引用
                            </span>
                          )}
                        </span>
                        <span className="num mt-1 line-clamp-2 text-xs break-all text-ink-3">{path || "/"}</span>
                      </span>
                      <ArrowUpRight className="size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                    </a>
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      )}

      <footer className="border-t border-line">
        <div className={cx(column, "flex flex-wrap items-center gap-x-6 gap-y-2 py-8 text-xs text-ink-3")}>
          <span className="flex items-center gap-2 text-ink-2">
            <Logo className="size-5" />
            由 SeekMux 深度研究生成
          </span>
          <span>持有链接者均可阅读，无需登录</span>
          <span className="num sm:ml-auto">链接有效期至 {dateTime(report.expires_at).slice(0, 10)}</span>
        </div>
      </footer>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-line px-4 py-2.5 last:border-b-0">
      <dt className="tag">{label}</dt>
      <dd className="num mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}
