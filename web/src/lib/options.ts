// Console text for the provider options the server declares (config.Option).

interface OptionText {
  label: string;
  info?: string;
  unit?: string;
  /** An example of the value, for free text. */
  placeholder?: string;
}

/** Keyed by `provider.tool.key`, or by the bare key for options every provider shares. */
const text: Record<string, OptionText> = {
  country: { label: "地区" },
  language: { label: "语言" },

  "brave.search.extra_snippets": { label: "额外摘要", info: "每条结果最多附带 5 段摘录；免费套餐下不生效" },
  "brave.search.safesearch": { label: "安全搜索" },
  "brave.search.goggles": {
    label: "Goggles",
    info: "重排规则：Goggle 文件的 URL，或一条内联规则。可对站点加权、降权或屏蔽",
    placeholder: "$boost=2,site=docs.python.org",
  },

  "exa.search.type": { label: "搜索类型", info: "instant、fast 更快；deep 系列多步检索，更慢更贵" },
  "exa.search.contents": { label: "内容格式", info: "highlights 为相关摘录，text 为正文开头，summary 为模型摘要（更慢更贵）" },
  "exa.search.max_characters": { label: "摘要长度上限", unit: "字符", info: "对 summary 无效" },
  "exa.search.max_age_hours": { label: "内容缓存时长", unit: "小时", info: "0 为始终实时抓取，-1 为只用缓存" },
  "exa.search.country": { label: "地区" },

  "exa.fetch.verbosity": { label: "正文详细度", info: "compact 只留正文，standard、full 保留更多页面结构" },
  "exa.fetch.max_age_hours": { label: "内容缓存时长", unit: "小时", info: "0 为始终实时抓取，-1 为只用缓存" },
  "exa.fetch.livecrawl_timeout_ms": { label: "实时抓取超时", unit: "ms" },

  "perplexity.search.search_type": { label: "搜索类型", info: "fast 比 web 便宜" },
  "perplexity.search.max_tokens_per_page": { label: "单条摘要上限", unit: "token", info: "256 token 约 1000 字符" },
  "perplexity.search.max_tokens": { label: "摘要总量上限", unit: "token", info: "一次查询全部结果合计" },
  "perplexity.search.language": { label: "语言", info: "硬性过滤：其他语言的结果会被剔除" },

  "tavily.search.search_depth": { label: "搜索深度", info: "advanced 最精确，费用加倍" },
  "tavily.search.chunks_per_source": { label: "每条结果片段数", info: "每段约 500 字符，advanced 约 800" },
  "tavily.search.topic": { label: "主题", info: "地区只对 general 生效" },
  "tavily.fetch.extract_depth": { label: "提取深度", info: "advanced 能提取表格和嵌入内容，费用加倍" },

  "jina.fetch.engine": { label: "抓取引擎", info: "browser 用无头浏览器渲染，curl 直接请求更快" },
  "jina.fetch.retain_images": { label: "图片", info: "none 移除，alt 只留替代文字，all 保留链接" },
  "jina.fetch.cache_tolerance_seconds": { label: "缓存最大时效", unit: "秒", info: "0 为不用缓存" },
  "jina.fetch.proxy_country": { label: "代理地区", info: "需要 API Key" },

  "firecrawl.search.highlights": { label: "相关摘录", info: "关闭后返回搜索引擎的原始摘要，更短" },
  "firecrawl.search.country": { label: "地区" },
  "firecrawl.dev_search.passages": { label: "每条结果段落数", info: "越多占用的上下文越多" },

  "firecrawl.fetch.max_age_hours": { label: "缓存时长", unit: "小时", info: "0 为始终重新抓取" },
  "firecrawl.fetch.proxy": { label: "代理", info: "enhanced 应对反爬更可靠但更慢；auto 先 basic，失败再切换" },
  "firecrawl.fetch.wait_for_ms": { label: "额外等待", unit: "ms", info: "用于内容延迟加载的页面" },
  "firecrawl.fetch.only_main_content": { label: "仅正文", info: "移除页眉、导航和页脚" },
  "firecrawl.fetch.pdf_mode": { label: "PDF 解析", info: "fast 只取内嵌文字，ocr 逐页识别，auto 先 fast 再 ocr" },
  "firecrawl.fetch.pdf_max_pages": { label: "PDF 页数上限", unit: "页", info: "PDF 按页计费" },
  "firecrawl.fetch.country": { label: "地区" },

  "parallel.search.mode": { label: "搜索模式", info: "turbo、fast 约 1 秒，basic 约 2 秒，advanced 质量最高约 3 秒" },
  "parallel.search.max_chars_per_result": { label: "摘要长度上限", unit: "字符" },
  "parallel.search.country": { label: "地区" },
  "parallel.fetch.max_age_hours": { label: "内容缓存时长", unit: "小时" },

  "anysearch.search.zone": { label: "区域", info: "cn 面向中国大陆，intl 面向国际" },
  "anysearch.search.language": { label: "语言", info: "AnySearch 不支持地区和时间范围；域名过滤由网关执行" },
};

export function optionText(provider: string, tool: string, key: string): OptionText {
  return text[`${provider}.${tool}.${key}`] ?? text[key] ?? { label: key };
}

/** Where a provider takes the route's extra parameters, with an example of each. */
export function extraText(provider: string, tool: string): { label: string; placeholder: string } {
  if (provider === "brave") return { label: "附加查询参数", placeholder: '{ "result_filter": "web" }' };
  if (provider === "jina") return { label: "附加请求头", placeholder: '{ "X-Timeout": 30 }' };
  return { label: "附加请求字段", placeholder: extraExamples[`${provider}.${tool}`] ?? '{ "参数名": "值" }' };
}

/** Fields each provider documents for the request, as examples. */
const extraExamples: Record<string, string> = {
  "exa.search": '{ "category": "news" }',
  "exa.fetch": '{ "subpages": 1 }',
  "tavily.search": '{ "include_answer": true }',
  "tavily.fetch": '{ "include_images": true }',
  "firecrawl.fetch": '{ "mobile": true }',
};
