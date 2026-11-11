import type { ReactNode } from "react";
import { Redirect, useParams } from "wouter";
import { PageHeader } from "../components/PageHeader";
import { toolPages } from "../lib/pages";
import { DevSearchPage } from "./DevSearch";
import { FetchPage } from "./Fetch";
import { ResearchPage } from "./Research";
import { SearchPage } from "./Search";

const pages: Record<string, () => ReactNode> = {
  search: SearchPage,
  "dev-search": DevSearchPage,
  fetch: FetchPage,
  research: ResearchPage,
};

/** The settings of one MCP tool, chosen in the sidebar. */
export function ToolsPage() {
  const { tool } = useParams<{ tool: string }>();
  const current = toolPages.find((t) => t.value === tool);
  if (!current) return <Redirect to={`/tools/${toolPages[0].value}`} replace />;
  const Page = pages[current.value];
  return (
    <>
      <PageHeader section="工具" title={current.label} />
      <Page />
    </>
  );
}
