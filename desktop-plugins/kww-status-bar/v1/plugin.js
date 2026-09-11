/** v1 仅使用宿主注入的固定插件 SDK。 */
(async () => {
  const api = window.kwwPlugin;
  const version = (await api.getHostVersion()).trim().replace(/^v+/i, '').trim();
  const value = { items: [{ id: 'version', type: 'text', text: `v${version}`, title: `客户端版本：v${version}`, tone: 'muted' }] };
  api.onLifecycle(async ({ type }) => {
    if (type === 'prepare') { await api.publishStatusBar(value); await api.ready(); }
    if (type === 'activate') { await api.publishStatusBar(value); await api.ready(); }
    if (type === 'drain') await api.ackDrained();
  });
  await api.hello();
})();
