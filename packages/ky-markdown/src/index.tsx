import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./style.css";
/** Shared safe reader: never enables raw HTML, embeds or executable protocols. */
export function MarkdownReader({ markdown }: { markdown: string }) {
 return <article className="ky-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(url)=>{
  if (/^(?:https?:|mailto:|\/|#)/i.test(url) && !url.startsWith("//")) return defaultUrlTransform(url);
  return "";
 }} components={{ a:({children,href})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img:({src,alt})=>src?<img src={src} alt={alt??""} loading="lazy" referrerPolicy="no-referrer"/>:null }}>{markdown}</ReactMarkdown></article>;
}
