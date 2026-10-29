import {useEffect} from "react";
import {requestClient} from "./remote-api";
import {loadSession} from "./app-store";
export function Presence(){useEffect(()=>{let pending=false;const touch=async()=>{if(pending||document.visibilityState!=="visible"||!loadSession())return;pending=true;try{await requestClient.request("/api/v1/auth/presence",{method:"POST",skipAuthRedirect:true})}catch{/* Presence is advisory; it never clears an authenticated session. */}finally{pending=false}};void touch();const id=window.setInterval(()=>void touch(),30000);document.addEventListener("visibilitychange",touch);return()=>{clearInterval(id);document.removeEventListener("visibilitychange",touch)}},[]);return null}
