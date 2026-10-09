import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { Route, Switch } from "wouter";
import { api, setUnauthorizedHandler } from "./lib/api";
import { ConfigProvider } from "./lib/config";
import { DesignPage } from "./pages/Design";
import { FetchPage } from "./pages/Fetch";
import { KeysPage } from "./pages/Keys";
import { LogsPage } from "./pages/Logs";
import { ModelsPage } from "./pages/Models";
import { OverviewPage } from "./pages/Overview";
import { PlaygroundPage } from "./pages/Playground";
import { ProvidersPage } from "./pages/Providers";
import { ResearchPage } from "./pages/Research";
import { SearchPage } from "./pages/Search";
import { SystemPage } from "./pages/System";
import { Logo, Shell } from "./Shell";
import { Button, Empty, Field, Input, Notice, Spinner, PasswordInput } from "./ui/primitives";

export function App() {
  const client = useQueryClient();
  const auth = useQuery({ queryKey: ["auth"], queryFn: api.authState });

  useEffect(() => {
    setUnauthorizedHandler(() => void client.invalidateQueries({ queryKey: ["auth"] }));
  }, [client]);

  if (auth.isPending) {
    return (
      <div className="grid h-screen place-items-center">
        <Spinner />
      </div>
    );
  }
  if (auth.error) {
    return (
      <div className="grid h-screen place-items-center">
        <Empty title="无法连接到 SeekMux 服务">{auth.error.message}</Empty>
      </div>
    );
  }
  if (!auth.data.authenticated) {
    return <Gate setup={auth.data.setup_required} onDone={() => client.invalidateQueries({ queryKey: ["auth"] })} />;
  }

  return (
    <ConfigProvider>
      <Shell>
        <Switch>
          <Route path="/" component={OverviewPage} />
          <Route path="/logs" component={LogsPage} />
          <Route path="/play" component={PlaygroundPage} />
          <Route path="/providers" component={ProvidersPage} />
          <Route path="/search" component={SearchPage} />
          <Route path="/fetch" component={FetchPage} />
          <Route path="/models" component={ModelsPage} />
          <Route path="/research" component={ResearchPage} />
          <Route path="/keys" component={KeysPage} />
          <Route path="/system" component={SystemPage} />
          <Route path="/design" component={DesignPage} />
          <Route>
            <Empty title="没有这个页面" />
          </Route>
        </Switch>
      </Shell>
    </ConfigProvider>
  );
}

/** The sign-in screen, or the first-run setup when no password exists yet. */
function Gate({ setup, onDone }: { setup: boolean; onDone: () => unknown }) {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await (setup ? api.setup(token, password) : api.login(password));
      await onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <Logo />
          <div>
            <div className="text-lg font-medium">SeekMux</div>
            <div className="tag">search · fetch · research gateway</div>
          </div>
        </div>
        <div className="flex flex-col gap-4 rounded-panel border border-line bg-surface p-5">
          {setup && (
            <>
              <Notice>首次启动，需要设置管理员密码。设置令牌打印在服务端启动日志里（setup_token）。</Notice>
              <Field label="设置令牌">
                <Input mono autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="setup_…" required />
              </Field>
            </>
          )}
          <Field label={setup ? "管理员密码" : "密码"} hint={setup ? "至少 10 个字符" : undefined} error={error}>
            <PasswordInput
              autoFocus={!setup}
              autoComplete={setup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={setup ? 10 : undefined}
              required
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            {setup ? "完成设置" : "登录"}
          </Button>
        </div>
      </form>
    </div>
  );
}
