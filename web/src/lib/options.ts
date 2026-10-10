// Console text for the provider options the server declares (config.Option).

interface OptionText {
  label: string;
  hint?: string;
  unit?: string;
}

/** Keyed by `provider.tool.key`, or by the bare key for options every provider shares. */
const text: Record<string, OptionText> = {
  country: { label: "地区", hint: "两位国家码，如 US。留空则继承上方的默认地区" },
  language: { label: "语言", hint: "两位语言码，如 zh。留空则继承上方的默认语言" },

  "brave.search.extra_snippets": { label: "额外摘要", hint: "每条结果最多附加 5 段摘录，描述更完整。免费套餐下不生效：请求仍会成功，但不含额外摘录" },
  "brave.search.safesearch": { label: "安全搜索", hint: "成人内容的过滤级别" },
  "brave.search.goggles": { label: "Goggles", hint: "自定义重排规则的 URL 或内联定义，可对站点加权、降权或屏蔽" },
  "brave.search.country": { label: "地区", hint: "两位国家码，留空则继承默认地区。Brave 仅支持部分国家" },

  "exa.search.type": { label: "搜索类型", hint: "instant、fast 速度更快；deep 系列执行多步检索，耗时与费用更高" },
  "exa.search.contents": { label: "摘要形态", hint: "highlights 是与查询相关的摘录，text 是正文开头，summary 是模型生成的摘要（另计费，慢几秒）" },
  "exa.search.max_characters": { label: "摘要长度上限", unit: "字符", hint: "每条结果的摘录或正文长度，对 summary 无效" },
  "exa.search.max_age_hours": { label: "内容缓存时长", unit: "小时", hint: "缓存超过该时长则重新抓取；0 为始终实时抓取，-1 为仅使用缓存。留空由 Exa 决定" },
  "exa.search.country": { label: "地区", hint: "两位国家码，留空则继承默认地区。Exa 不支持语言参数" },

  "exa.fetch.verbosity": { label: "正文详细度", hint: "compact 仅保留正文，standard、full 依次保留更多页面结构" },
  "exa.fetch.max_age_hours": { label: "内容缓存时长", unit: "小时", hint: "缓存超过该时长则重新抓取；0 为始终实时抓取，-1 为仅使用缓存。留空则仅在无缓存时抓取" },
  "exa.fetch.livecrawl_timeout_ms": { label: "实时抓取超时", unit: "ms" },

  "perplexity.search.search_type": { label: "搜索类型", hint: "fast 费用更低：每千次 $1，web 为 $5" },
  "perplexity.search.max_tokens_per_page": { label: "单条摘要上限", unit: "token", hint: "256 token 约合 1000 字符" },
  "perplexity.search.max_tokens": { label: "摘要总量上限", unit: "token", hint: "单次查询全部结果的摘要合计。留空则不限制" },
  "perplexity.search.language": { label: "语言", hint: "两位语言码，留空则继承默认语言。此处为硬性过滤：其他语言的结果会被剔除" },

  "tavily.search.search_depth": { label: "搜索深度", hint: "advanced 最精确，每次 2 credit；其余每次 1 credit" },
  "tavily.search.chunks_per_source": { label: "每条结果片段数", hint: "每段约 500 字符，advanced 约 800" },
  "tavily.search.topic": { label: "主题", hint: "news 面向时事，finance 面向财经。地区只对 general 生效" },
  "tavily.fetch.extract_depth": { label: "提取深度", hint: "advanced 可提取表格和嵌入内容，成功率更高，费用加倍" },

  "jina.fetch.engine": { label: "抓取引擎", hint: "browser 使用无头浏览器渲染，curl 直接请求、速度更快，auto 自动选择" },
  "jina.fetch.retain_images": { label: "图片", hint: "none 移除图片，alt 仅保留替代文字，all 保留图片链接" },
  "jina.fetch.cache_tolerance_seconds": { label: "缓存容忍时长", unit: "秒", hint: "可接受的缓存最长时效，0 为不使用缓存。留空为 Jina 默认的 1 小时" },
  "jina.fetch.proxy_country": { label: "代理地区", hint: "经该国家的代理访问页面，两位国家码。需要 API key" },

  "firecrawl.search.highlights": { label: "相关摘录", hint: "摘要取页面中与查询相关的段落；关闭后返回搜索引擎的原始摘要，更短" },
  "firecrawl.search.country": { label: "地区", hint: "两位国家码，留空则继承默认地区。Firecrawl 不支持语言参数" },

  "firecrawl.fetch.max_age_hours": { label: "缓存时长", unit: "小时", hint: "缓存未超过该时长时直接返回，0 为始终重新抓取" },
  "firecrawl.fetch.proxy": { label: "代理", hint: "enhanced 对有反爬措施的站点更可靠，但速度较慢；auto 先使用 basic，失败后切换" },
  "firecrawl.fetch.wait_for_ms": { label: "额外等待", unit: "ms", hint: "页面加载后额外等待该时长再提取内容，适用于内容延迟加载的页面" },
  "firecrawl.fetch.only_main_content": { label: "仅正文", hint: "移除页眉、导航和页脚" },
  "firecrawl.fetch.pdf_mode": { label: "PDF 解析", hint: "fast 仅提取内嵌文字，ocr 逐页识别，auto 先 fast 再 ocr" },
  "firecrawl.fetch.pdf_max_pages": { label: "PDF 页数上限", unit: "页", hint: "PDF 按页计费，每页 1 credit。留空则不限制" },
  "firecrawl.fetch.country": { label: "地区", hint: "从该国家访问页面，两位国家码" },
};

export function optionText(provider: string, tool: string, key: string): OptionText {
  return text[`${provider}.${tool}.${key}`] ?? text[key] ?? { label: key };
}

/** Where a provider takes the route's extra parameters. */
export function extraText(provider: string): { label: string; placeholder: string } {
  if (provider === "brave") return { label: "附加查询参数", placeholder: '{ "result_filter": "web" }' };
  if (provider === "jina") return { label: "附加请求头", placeholder: '{ "X-Timeout": 30 }' };
  return { label: "附加请求字段", placeholder: '{ "key": "value" }' };
}
