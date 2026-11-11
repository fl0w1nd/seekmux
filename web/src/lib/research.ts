// Console text for the research budget and reading mode, shared by the
// research settings and the playground.

export type BudgetKey = "max_steps" | "max_duration_seconds" | "max_tokens" | "max_context_tokens";

export const budgetInfo: Record<BudgetKey, string> = {
  max_steps: "一步为模型的一轮推理，可同时发起多次搜索和抓取",
  max_duration_seconds: "达到 80% 时开始收尾并撰写报告",
  max_tokens: "各步输入与输出的累计",
  max_context_tokens: "单次请求的输入上限，应低于模型的上下文窗口",
};

/** What the chosen reading mode means, given whether an extraction model is set. */
export function readingText(reading: "raw" | "extract", extractReady: boolean): string {
  if (reading === "raw") return "研究模型直接读原文：最准确，最耗上下文";
  return extractReady ? "提取模型先按问题提炼网页：省上下文，准确度取决于提取模型" : "未配置提取模型，仍按原文读取";
}
