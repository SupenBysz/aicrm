/** v2 在同一宿主 UI 协议内增加版本详情展开交互。 */
(async () => {
  const api = window.kwwPlugin;
  const version = (await api.getHostVersion()).trim().replace(/^v+/i, '').trim();
  let expanded = false;
  const publish = () => api.publishStatusBar({ items: [{ id: 'version', type: 'button', text: expanded ? `客户端 v${version}` : `v${version}`, title: '点击展开或收起客户端版本', tone: 'muted', actionId: 'toggle-version' }] });
  api.onAction(async ({ requestId, actionId }) => {
    try { if (actionId === 'toggle-version') { expanded = !expanded; await publish(); } }
    finally { await api.ackAction(requestId); }
  });
  api.onLifecycle(async ({ type }) => {
    if (type === 'prepare' || type === 'activate') { await publish(); await api.ready(); }
    if (type === 'drain') await api.ackDrained();
  });
  await api.hello();
})();
