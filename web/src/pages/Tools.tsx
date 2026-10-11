import { Redirect, useLocation, useParams } from "wouter";
import { PageHeader } from "../Shell";
import { TabList, TabPanel, Tabs } from "../ui/primitives";
import { DevSearchPage } from "./DevSearch";
import { FetchPage } from "./Fetch";
import { ResearchPage } from "./Research";
import { SearchPage } from "./Search";

const tools = [
  { value: "search", label: "网页搜索", page: SearchPage },
  { value: "dev-search", label: "开发搜索", page: DevSearchPage },
  { value: "fetch", label: "网页抓取", page: FetchPage },
  { value: "research", label: "深度研究", page: ResearchPage },
];

/** The settings of every MCP tool, one tab each; the tab is part of the address. */
export function ToolsPage() {
  const { tool } = useParams<{ tool: string }>();
  const [, navigate] = useLocation();
  const current = tools.find((t) => t.value === tool);
  if (!current) return <Redirect to={`/tools/${tools[0].value}`} replace />;
  return (
    <>
      <PageHeader title="工具" description="MCP 工具的路由、行为与参数。" />
      <Tabs value={current.value} onChange={(value) => navigate(`/tools/${value}`)}>
        <TabList flush tabs={tools.map(({ value, label }) => ({ value, label }))} />
        <TabPanel value={current.value} className="pt-6">
          <current.page />
        </TabPanel>
      </Tabs>
    </>
  );
}
