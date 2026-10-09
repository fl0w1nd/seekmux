import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "./primitives";

// Fetched pages are untrusted: raw HTML is never rendered (react-markdown's
// default), and images become links so that showing a page does not make
// requests to the sites it embeds.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noreferrer noopener" className="md-image">
        图片{alt ? `：${alt}` : ""}
      </a>
    ) : null,
};

/** Markdown from a provider or a model, set in the console's type. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("md", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
