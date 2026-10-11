import type { Config, Meta, Rule } from "./api";

/** The rules in the order they are tried: the configuration's own, then the built-in ones as it changed them. */
export function routingRules(config: Config, meta: Meta): Rule[] {
  const builtin = meta.rules.map((rule) => {
    const change = config.routing.builtin?.[rule.id];
    return { ...rule, enabled: Boolean(change?.enabled), providers: change?.providers?.length ? change.providers : rule.providers };
  });
  return [...config.routing.rules, ...builtin];
}

/** Reduces what a person may paste, a full URL included, to host[/path-prefix], as the server does. */
export function cleanPattern(raw: string): string {
  let text = raw.trim();
  const scheme = text.indexOf("://");
  if (scheme >= 0) text = text.slice(scheme + 3);
  text = text.split(/[?#]/)[0];
  const slash = text.indexOf("/");
  const host = (slash < 0 ? text : text.slice(0, slash))
    .toLowerCase()
    .split(":")[0]
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  const path = slash < 0 ? "" : text.slice(slash + 1);
  return path ? `${host}/${path}` : host;
}

const hostPattern = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/;

export const validPattern = (pattern: string) => hostPattern.test(pattern.split("/")[0]);

/** The enabled rule that covers pages of a registrable domain, if any. */
export function ruleForDomain(rules: Rule[], domain: string): Rule | undefined {
  return rules.find(
    (rule) =>
      rule.enabled &&
      rule.match.some((pattern) => {
        const host = pattern.split("/")[0];
        return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
      }),
  );
}

/** An id for a new rule, in the form the server accepts. */
export const newRuleID = () => `r-${Math.random().toString(36).slice(2, 10)}`;
