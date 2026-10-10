import { useState, type ComponentType } from "react";
import { DevSearchPlay } from "./DevSearch";
import { FetchPlay } from "./Fetch";
import { ResearchPlay } from "./Research";
import { SearchPlay } from "./Search";

/** The playground pages by the last part of their path, /play/<name>. */
const pages: Record<string, ComponentType> = {
  search: SearchPlay,
  "dev-search": DevSearchPlay,
  fetch: FetchPlay,
  research: ResearchPlay,
};

/** The playground page a path shows, if it shows one. */
export function playPage(path: string): string | undefined {
  const name = /^\/play\/([^/]+)\/?$/.exec(path)?.[1];
  return name !== undefined && name in pages ? name : undefined;
}

/**
 * The playground. A page is built on its first visit and then stays, hidden
 * while another page of the console is on show: coming back from a settings
 * page finds the form, the result and a research run under way as they were.
 */
export function Playground({ page }: { page: string | undefined }) {
  const [visited, setVisited] = useState<string[]>([]);
  if (page && !visited.includes(page)) setVisited([...visited, page]);
  return visited.map((name) => {
    const Page = pages[name];
    return (
      <div key={name} hidden={name !== page}>
        <Page />
      </div>
    );
  });
}
