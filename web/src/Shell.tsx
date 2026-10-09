import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Boxes,
  FileText,
  FlaskConical,
  Gauge,
  KeyRound,
  LogOut,
  Monitor,
  Moon,
  ScrollText,
  Search,
  Settings,
  Sun,
  Telescope,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api } from "./lib/api";
import { useConfig } from "./lib/config";
import { Button, cx, Dot, Segmented, Tooltip } from "./ui/primitives";

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx("size-8 shrink-0", className)} aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-signal" />
      <path
        d="M7 10h6l6 12h6M7 22h6l2-4M19 14l2-4h4"
        fill="none"
        className="stroke-signal-ink"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const nav = [
  {
    group: "观测",
    items: [
      { href: "/", label: "概览", icon: Gauge },
      { href: "/logs", label: "请求日志", icon: ScrollText },
      { href: "/play", label: "调试台", icon: FlaskConical },
    ],
  },
  {
    group: "网关",
    items: [
      { href: "/providers", label: "提供商", icon: Boxes },
      { href: "/search", label: "搜索", icon: Search },
      { href: "/fetch", label: "抓取", icon: FileText },
    ],
  },
  {
    group: "Agent",
    items: [
      { href: "/models", label: "模型接口", icon: Bot },
      { href: "/research", label: "深度研究", icon: Telescope },
    ],
  },
  {
    group: "访问与系统",
    items: [
      { href: "/keys", label: "访问密钥", icon: KeyRound },
      { href: "/system", label: "系统", icon: Settings },
    ],
  },
];

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("seekmux-theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  useEffect(() => {
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
      localStorage.removeItem("seekmux-theme");
    } else {
      document.documentElement.dataset.theme = theme;
      localStorage.setItem("seekmux-theme", theme);
    }
  }, [theme]);
  return [theme, setTheme];
}

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { meta, dirty, saving, save, discard } = useConfig();
  const client = useQueryClient();
  const [theme, setTheme] = useTheme();

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface max-md:w-14">
        <div className="flex h-14 items-center gap-2.5 px-3.5">
          <Logo className="size-7" />
          <div className="leading-tight max-md:hidden">
            <div className="font-medium">SeekMux</div>
            <div className="tag normal-case">{meta.version}</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          {nav.map((section) => (
            <div key={section.group} className="mt-4 first:mt-1">
              <div className="tag px-2 pb-1.5 max-md:hidden">{section.group}</div>
              {section.items.map(({ href, label, icon: Icon }) => {
                const active = href === "/" ? location === "/" : location.startsWith(href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    title={label}
                    className={cx(
                      "relative flex h-8 items-center gap-2.5 rounded-ctl px-2 text-sm transition-colors max-md:justify-center",
                      active ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised/60 hover:text-ink",
                    )}
                  >
                    {active && <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-signal-text" />}
                    <Icon className={cx("size-4 shrink-0", active ? "text-signal-text" : "text-ink-3")} />
                    <span className="max-md:hidden">{label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-line p-2.5 max-md:flex-col">
          <div className="max-md:hidden">
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
          <Tooltip content="退出登录">
            <Button
              variant="ghost"
              size="sm"
              icon={<LogOut />}
              aria-label="退出登录"
              onClick={async () => {
                await api.logout();
                await client.invalidateQueries({ queryKey: ["auth"] });
              }}
            />
          </Tooltip>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className={cx("mx-auto w-full max-w-6xl px-6 py-6 max-md:px-4", dirty && "pb-24")}>{children}</div>
      </main>

      {dirty && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4 pl-60 max-md:pl-18">
          <div className="flex animate-in items-center gap-4 rounded-panel border border-line-strong bg-overlay py-2 pr-2 pl-4 shadow-overlay">
            <span className="flex items-center gap-2.5 text-sm">
              <Dot tone="warn" live />
              有未保存的更改，保存后立即生效
            </span>
            <span className="flex gap-2">
              <Button variant="ghost" onClick={discard} disabled={saving}>
                放弃
              </Button>
              <Button variant="primary" onClick={save} loading={saving}>
                保存
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The heading every page starts with. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-medium tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
