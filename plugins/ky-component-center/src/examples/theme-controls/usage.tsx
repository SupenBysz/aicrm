import { AppearanceControls, type ThemeId, type AppearanceMode } from "@ky/admin-core";
import { useState } from "react";
export default function Example({ label = "外观选择", disabled = false }: { label?: string; disabled?: boolean } = {}) {
const [value,setValue]=useState<{themeId:ThemeId;mode:AppearanceMode}>({themeId:"classic-gold",mode:"light"});return <><AppearanceControls {...value} disabled={disabled} label="模拟外观" onChange={(themeId,mode)=>setValue({themeId,mode})}/><p>仅演示选择值：{value.themeId} / {value.mode}，不会保存真实偏好。整体配色请使用预览工具栏。</p></>;
}
