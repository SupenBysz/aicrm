export type CopyrightStyle = "standard" | "full" | "chinese";
export const copyrightStyleOptions = [
  { value: "standard", label: "标准" },
  { value: "full", label: "完整" },
  { value: "chinese", label: "中文" }
];
export function formatCopyright(holder: string, style: CopyrightStyle = "standard", now = new Date(), timeZone?: string): string {
  const name = holder.trim();
  if (!name) return "";
  const year = new Intl.DateTimeFormat("en", { year: "numeric", ...(timeZone ? { timeZone } : {}) }).format(now);
  if (style === "full") return `Copyright © ${year} ${name}. All rights reserved.`;
  return `© ${year} ${name}${style === "chinese" ? " 版权所有" : ""}`;
}
