import type { RequestClient } from "@ky/admin-core";
export interface DocumentDraft { id:string;slug:string;title:string;category:string;status:string;version:number;publicationVersion?:number;revision:number;markdown:string;note:string;dirty:boolean;updatedBy:string;updatedAt:string;publishedAt?:string }
export interface DocumentVersion {publishedBy?:string;version:number;title:string;markdown:string;note:string;digest:string;publishedAt:string}
export interface DocumentBinding {purpose:string;documentId:string|null;revision:number}
export const documentAPI=(client:RequestClient)=>({
 list:(query:string)=>client.request<{items:DocumentDraft[];pagination:{page:number;pageSize:number;total:number}}>(`/api/v1/platform/documents?${query}`),
 get:(id:string)=>client.request<DocumentDraft>(`/api/v1/platform/documents/${id}`),
 create:(body:unknown)=>client.request<DocumentDraft>("/api/v1/platform/documents",{method:"POST",body}),
 change:(id:string,action:string,body:unknown)=>client.request<DocumentDraft>(`/api/v1/platform/documents/${id}${action==="delete"?"":"/"+action}`,{method:action==="draft"?"PATCH":action==="delete"?"DELETE":"POST",body}),
 versions:(id:string)=>client.request<{items:DocumentVersion[]}>(`/api/v1/platform/documents/${id}/versions`),
 version:(id:string,n:number)=>client.request<DocumentVersion>(`/api/v1/platform/documents/${id}/versions/${n}`),
 bindings:()=>client.request<{items:DocumentBinding[]}>("/api/v1/platform/document-links"),
 bind:(body:DocumentBinding)=>client.request<{items:DocumentBinding[]}>("/api/v1/platform/document-links",{method:"PATCH",body})
});
