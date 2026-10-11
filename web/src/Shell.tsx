import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Boxes,
  Braces,
  Gauge,
  Globe,
  KeyRound,
  LogOut,
  Menu,
  Microscope,
  Monitor,
  Moon,
  Route,
  ScanText,
  ScrollText,
  Settings,
  Sun,
  Wrench,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api } from "./lib/api";
import { useConfig } from "./lib/config";
import { Drawer } from "./ui/overlays";
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
    group: "监控",
    items: [
      { href: "/", label: "概览", icon: Gauge },
      { href: "/logs", label: "请求日志", icon: ScrollText },
    ],
  },
  {
    group: "调试台",
    items: [
      { href: "/play/search", label: "网页搜索", icon: Globe },
      { href: "/play/dev-search", label: "开发搜索", icon: Braces },
      { href: "/play/fetch", label: "网页抓取", icon: ScanText },
      { href: "/play/research", label: "深度研究", icon: Microscope },
    ],
  },
  {
    group: "网关",
    items: [
      { href: "/providers", label: "提供商", icon: Boxes },
      { href: "/models", label: "模型接口", icon: Bot },
      { href: "/tools", label: "工具", icon: Wrench },
      { href: "/routing", label: "服务路由", icon: Route },
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

export function useTheme(): [Theme, (theme: Theme) => void] {
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

function NavList({ location }: { location: string }) {
  return (
    <nav className="flex-1 overflow-y-auto px-2 pb-4">
      {nav.map((section) => (
        <div key={section.group} className="mt-4 first:mt-1">
          <div className="tag px-2 pb-1.5">{section.group}</div>
          {section.items.map(({ href, label, icon: Icon }) => {
            const active = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative flex h-8 items-center gap-2.5 rounded-ctl px-2 text-sm transition-colors max-md:h-10",
                  active ? "bg-raised text-ink" : "text-ink-2 hover:bg-raised/60 hover:text-ink",
                )}
              >
                {active && <span className="absolute inset-y-1.5 -left-2 w-0.5 rounded-full bg-signal-text" />}
                <Icon className={cx("size-4 shrink-0", active ? "text-signal-text" : "text-ink-3")} />
                {label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Theme and sign-out, the foot of the sidebar and of the menu on a phone. */
function NavFoot() {
  const client = useQueryClient();
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line p-2.5">
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
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { meta, saving, error, retry, discard } = useConfig();
  const [menu, setMenu] = useState(false);
  const current = nav.flatMap((section) => section.items).find(({ href }) => (href === "/" ? location === "/" : location.startsWith(href)));

  // The menu of a phone closes once a page is chosen.
  useEffect(() => setMenu(false), [location]);

  return (
    <div className="flex min-h-dvh max-md:flex-col">
      <aside className="sticky top-0 flex h-dvh w-56 shrink-0 flex-col border-r border-line bg-surface max-md:hidden">
        <div className="flex h-14 items-center gap-2.5 px-3.5">
          <Logo className="size-7" />
          <div className="leading-tight">
            <div className="font-medium">SeekMux</div>
            <div className="tag normal-case">{saving ? "保存中…" : meta.version}</div>
          </div>
        </div>
        <NavList location={location} />
        <NavFoot />
      </aside>

      <header className="sticky top-0 z-20 hidden h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-line bg-surface pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] max-md:flex">
        <Button variant="ghost" className="size-10" icon={<Menu />} aria-label="打开菜单" onClick={() => setMenu(true)} />
        <Logo className="size-6" />
        <div className="min-w-0 flex-1 truncate font-medium">{current?.label ?? "SeekMux"}</div>
        {saving && <span className="tag normal-case">保存中…</span>}
      </header>
      <Drawer open={menu} onOpenChange={setMenu} side="left" title="SeekMux" description={meta.version} bodyClassName="flex flex-col p-0">
        <NavList location={location} />
        <NavFoot />
      </Drawer>

      <main className="min-w-0 flex-1">
        <div
          className={cx(
            "mx-auto w-full max-w-6xl px-6 py-6 max-md:px-4",
            "max-md:pr-[max(1rem,env(safe-area-inset-right))] max-md:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-md:pl-[max(1rem,env(safe-area-inset-left))]",
            error && "pb-24",
          )}
        >
          {children}
        </div>
      </main>

      {error && (
        <div className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex justify-center px-4 pl-60 max-md:pl-4">
          <div className="flex max-w-2xl animate-in items-center gap-4 rounded-panel border border-line-strong bg-overlay py-2 pr-2 pl-4 shadow-overlay max-md:flex-wrap max-md:gap-2">
            <span className="flex min-w-0 items-start gap-2.5 text-sm">
              <Dot tone="err" className="mt-2" />
              <span className="min-w-0 break-words">配置保存失败：{error}</span>
            </span>
            <span className="flex shrink-0 gap-2">
              <Button variant="ghost" onClick={discard}>
                放弃修改
              </Button>
              <Button variant="primary" onClick={retry}>
                重试
              </Button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The sentence under a tab that says what the tool does; the page heading is the tab strip's. */
export function ToolIntro({ children }: { children: ReactNode }) {
  return <p className="mb-6 max-w-2xl text-sm text-ink-3">{children}</p>;
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
