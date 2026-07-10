export function getDesktopBridge() {
  const bridge = window.aicrm;
  if (!bridge?.app || !bridge.api || !bridge.session) {
    throw new Error("客户端安全桥未加载，请从 AiCRM 客户端窗口打开。");
  }
  return bridge;
}
