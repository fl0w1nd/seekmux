import { useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Boxes,
  Braces,
  ChevronRight,
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
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { api } from "./lib/api";
import { useConfig } from "./lib/config";
import { providerCategories, routingPages, toolPages } from "./lib/pages";
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

interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** The pages under the item, listed beneath it while it is open. */
  sub?: ComponentType<{ location: string }>;
}

const nav: { group: string; items: NavItem[] }[] = [
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
      { href: "/providers", label: "提供商", icon: Boxes, sub: ProviderLinks },
      { href: "/models", label: "模型接口", icon: Bot },
      { href: "/tools", label: "工具", icon: Wrench, sub: ToolLinks },
      { href: "/routing", label: "服务路由", icon: Route, sub: RoutingLinks },
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

/** Whether the address is the page of `href` or one under it. */
const within = (href: string, location: string) => (href === "/" ? location === "/" : location === href || location.startsWith(`${href}/`));

function NavList({ location }: { location: string }) {
  return (
    <nav className="flex-1 overflow-y-auto px-2.5 pb-4">
      {nav.map((section) => (
        <div key={section.group} className="mt-5 first:mt-2">
          <div className="tag px-2 pb-1.5">{section.group}</div>
          {section.items.map((item) => (
            <NavEntry key={item.href} item={item} location={location} />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** One item of the sidebar; an item with pages under it opens into a list of them while one is on show. */
function NavEntry({ item, location }: { item: NavItem; location: string }) {
  const { href, label, icon: Icon, sub: Sub } = item;
  const active = within(href, location);
  // Open while one of its pages is on show; the chevron opens or closes it in between.
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);
  // With a list beneath it, the item only marks where the chosen page lives; the page itself carries the thumb.
  const own = active && !Sub;

  return (
    <div>
      <div className="relative mt-px">
        <Link
          href={href}
          aria-current={own ? "page" : undefined}
          className={cx(
            "flex h-8 items-center gap-2.5 rounded-ctl px-2 text-sm transition-colors max-md:h-10",
            own ? "bg-surface font-medium text-ink shadow-thumb" : active ? "font-medium text-ink hover:bg-fill" : "text-ink-2 hover:bg-fill hover:text-ink",
          )}
        >
          <Icon className={cx("size-4 shrink-0", active ? "text-ink" : "text-ink-3")} />
          {label}
        </Link>
        {Sub && (
          <button
            type="button"
            aria-label={open ? `收起${label}` : `展开${label}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="press absolute inset-y-0 right-0 grid w-8 place-items-center rounded-ctl text-ink-3 transition-colors hover:text-ink"
          >
            <ChevronRight className={cx("size-3.5 transition-transform duration-150", open && "rotate-90")} />
          </button>
        )}
      </div>
      {Sub && open && (
        <div className="mt-0.5 mb-1.5 ml-4 flex animate-in flex-col gap-px border-l border-line pl-2">
          <Sub location={location} />
        </div>
      )}
    </div>
  );
}

/** A page in the list beneath a sidebar item. */
function SubLink({ href, location, children }: { href: string; location: string; children: ReactNode }) {
  const active = within(href, location);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex h-7 items-center rounded-ctl px-2 text-sm transition-colors max-md:h-9",
        active ? "bg-surface font-medium text-ink shadow-thumb" : "text-ink-2 hover:bg-fill hover:text-ink",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

function ProviderLinks({ location }: { location: string }) {
  return providerCategories.map(({ value, label }) => (
    <SubLink key={value} href={`/providers/${value}`} location={location}>
      {label}
    </SubLink>
  ));
}

function ToolLinks({ location }: { location: string }) {
  return toolPages.map(({ value, label }) => (
    <SubLink key={value} href={`/tools/${value}`} location={location}>
      {label}
    </SubLink>
  ));
}

function RoutingLinks({ location }: { location: string }) {
  return routingPages.map(({ value, label }) => (
    <SubLink key={value} href={`/routing/${value}`} location={location}>
      {label}
    </SubLink>
  ));
}

/** Theme and sign-out, the foot of the sidebar and of the menu on a phone. */
function NavFoot() {
  const client = useQueryClient();
  const [theme, setTheme] = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2.5">
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
  const { meta, saving, saved, error, retry, discard } = useConfig();
  const [menu, setMenu] = useState(false);
  // Every monitoring and management page shares one 68rem measure so headings and panel edges never shift; only workbenches and call flows widen.
  const measure = /^\/(play\/|logs\/.)/.test(location) ? "max-w-[96rem]" : "max-w-[68rem]";
  const current = nav.flatMap((section) => section.items).find(({ href }) => within(href, location));

  // The menu of a phone closes once a page is chosen.
  useEffect(() => setMenu(false), [location]);

  return (
    <div className="flex min-h-dvh max-md:flex-col">
      <aside className="sticky top-0 flex h-dvh w-60 shrink-0 flex-col bg-bg max-md:hidden">
        <div className="flex h-15 items-center gap-2.5 px-4.5">
          <Logo className="size-7" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">SeekMux</div>
            <div className={cx("num text-2xs text-ink-3 transition-colors", saved && "text-ok")}>
              {saving ? "保存中…" : saved ? "✓ 已保存" : meta.version}
            </div>
          </div>
        </div>
        <NavList location={location} />
        <NavFoot />
      </aside>

      <header className="sticky top-0 z-20 hidden h-[calc(3rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-line bg-surface/90 backdrop-blur-md pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] max-md:flex">
        <Button variant="ghost" className="size-10" icon={<Menu />} aria-label="打开菜单" onClick={() => setMenu(true)} />
        <Logo className="size-6" />
        <div className="min-w-0 flex-1 truncate text-sm font-semibold">{current?.label ?? "SeekMux"}</div>
        {(saving || saved) && (
          <span className={cx("text-xs text-ink-3 transition-colors", saved && "text-ok")}>{saving ? "保存中…" : "✓ 已保存"}</span>
        )}
      </header>
      <Drawer open={menu} onOpenChange={setMenu} side="left" title="SeekMux" description={meta.version} bodyClassName="flex flex-col p-0">
        <NavList location={location} />
        <NavFoot />
      </Drawer>

      {/* The pages sit on one sheet beside the sidebar, starting right after it. */}
      <main className="min-w-0 flex-1 md:py-2 md:pr-2">
        <div className="bg-surface max-md:min-h-[calc(100dvh-3rem)] md:min-h-[calc(100dvh-1rem)] md:rounded-panel md:border md:border-line md:shadow-panel">
          <div
            className={cx(
              "mx-auto w-full px-8 pt-6 pb-12 max-md:px-4 max-md:pt-4",
              measure,
              "max-md:pr-[max(1rem,env(safe-area-inset-right))] max-md:pb-[max(1.5rem,env(safe-area-inset-bottom))] max-md:pl-[max(1rem,env(safe-area-inset-left))]",
              error && "pb-24",
            )}
          >
            {children}
          </div>
        </div>
      </main>

      {error && (
        <div className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-30 flex justify-center px-4 pl-64 max-md:pl-4">
          <div className="flex max-w-2xl animate-in items-center gap-4 rounded-panel bg-overlay py-2 pr-2 pl-4 shadow-overlay max-md:flex-wrap max-md:gap-2">
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
