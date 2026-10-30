import type {DocumentDraft} from "./documents-api";
// Memory only, scoped by user and workspace; never persist document text on disk.
const drafts=new Map<string,DocumentDraft>();
export function readDocumentDraft(key:string){const value=key?drafts.get(key):undefined;return value?{...value}:null}
export function rememberDocumentDraft(key:string,value:DocumentDraft|null){if(!key)return;if(value)drafts.set(key,{...value});else drafts.delete(key)}
export function clearDocumentDrafts(){drafts.clear()}
if(typeof window!=="undefined")window.addEventListener("ky:session-changed",clearDocumentDrafts);
