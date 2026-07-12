# AiCRM Event Communication Reference

Use this reference with the canonical document:

```text
docs/aicrm_desktop_event_communication_standard.md
```

This file exists inside the solution skill so the project template carries the communication rules even before the full project docs are reviewed.

## Communication Types

Use the smallest communication mechanism that matches the boundary:

| Type | Direction | Use for |
| --- | --- | --- |
| Command | Web -> preload -> main | Native side effects such as minimize, full screen, always-on-top, session save/clear |
| Query | Web -> preload -> main | Snapshot reads such as window state, app version, network-log snapshot |
| Native Event | main -> preload/Web | Native state changes such as window state or network-log append |
| Web Local Event | Web process | Login, logout, workspace change, theme, lock/unlock, notification count |
| Authenticated SSE | Service -> Host adapter -> Plugin/store | Persistent business state, task progress, resumable history |
| Integration Event | Service outbox -> NATS -> Service consumer | At-least-once safe references between backend domains |

Do not use DOM events or arbitrary `ipcRenderer` channel forwarding as the cross-process standard. Do not route SSE through Electron IPC, and do not expose NATS to Renderer or Plugin code.

## Subscription Rules

- Expose native subscriptions as `window.aicrm.<domain>.onXxx(listener): () => void`.
- Return an unsubscribe function from every `onXxx`.
- Subscribe in React only inside `useEffect`, and call unsubscribe in cleanup.
- Prefer one stable subscription per domain in an adapter, provider, store, or shell component.
- Keep page, table row, form item, and temporary overlay components from owning shared long-lived subscriptions.
- Catch listener errors so one consumer cannot break later event dispatch.
- Keep payloads JSON-serializable and free of passwords, tokens, cookies, verification codes, and raw secrets.
- For operation events, include a runtime epoch and monotonic sequence; on a gap, overflow, or epoch change, discard buffered deltas and reread the snapshot.

Example:

```tsx
useEffect(() => {
  const bridge = getDesktopBridge();
  const unsubscribe = bridge?.window?.onStateChanged?.((state) => {
    setWindowState(state);
  });

  return () => {
    unsubscribe?.();
  };
}, []);
```

## Consumption Rules

- Treat event handling as idempotent. Duplicate events must not create duplicate requests, repeated prompts, or repeated navigation.
- Validate session, workspace, permissions, and page context before applying event payloads.
- Discard events for stale workspace/session context.
- Read the initial state through `getState/getSnapshot` before relying on incremental events.
- For non-persistent Native Events, subscribe and buffer first, read the sequence-bearing snapshot second, then drain only newer events.
- Convert native events through `desktop-client.ts` or an equivalent adapter before business modules consume them.
- Fan out Web-only business events through a typed local event bus or store, not through Electron IPC.
- Never consume events by directly mutating unrelated global state from a low-level listener.

Recommended flow:

```text
main Native Event
  -> preload onXxx
  -> desktop-client.ts adapter
  -> app-event-bus/store
  -> page consumes derived state
```

## Channel And Payload Rules

- Define all physical channels in `apps/aicrm-desktop/src/shared/constants.ts`.
- Define payload/result/envelope types in `apps/aicrm-desktop/src/shared/types.ts` or `shared/events.ts`.
- Use `<domain>:<action>` for commands and queries.
- Use `<domain>:<event>` with past-tense or state-change names for events.
- For new complex events, prefer an envelope with `id`, `name`, `version`, `source`, `scope`, `occurredAt`, `correlationId`, and `payload`.
- Keep legacy events compatible until a planned bridge version removes them.

## Trusted Desktop Commands

以下规则适用于会修改 Vault、凭据、App Server、受控 WebSpace 或其他租户原生状态的受保护 Command；普通窗口最小化等无租户副作用的本地命令仍按能力白名单处理。

- Renderer requests a business operation from the service; the service persists it before issuing a short-lived single-use Command Ticket.
- The ticket binds audience, purpose, operation, device, target revision, expiry and nonce. A raw resource ID never authorizes a local write.
- Main verifies the ticket before touching Vault, credentials, App Server state or other protected local resources.
- Device proof/ACK covers the normalized request and uses a key-generation, sequence, nonce and request-hash ledger.
- Plugin and Renderer never forward private keys, raw proof material, receipts, credentials, paths or original App Server protocol messages.
- A Desktop-side App Server remains a Main-managed stdio child; it is not exposed as a socket, WebSocket or business plugin API. Server-side App Server lifecycle remains owned by the executor service.

## Authenticated SSE

- Host owns the fetch stream and injects Bearer auth, workspace headers and request ID; Plugin consumes a typed adapter/store.
- Persisted event sequence is the SSE ID. `Last-Event-ID` takes precedence over `after`, and reconnect resumes from history.
- Heartbeats carry no resource mutation. Terminal and stream-closed events have their own increasing IDs.
- Permission/workspace loss closes the connection without persisting a tenant event. URL tokens are forbidden.

## Outbox And NATS

- Domain state, event sequence and transactional outbox are committed together in the owning service database.
- NATS payload contains a versioned event ID, opaque resource ID, workspace scope, terminal/status summary and occurred time only.
- Credentials, Cookie/Storage, paths, raw logs, DOM, screenshots, receipts and result bodies are forbidden.
- Consumers deduplicate by event ID and resource ID, then fetch authorized detail from the owner internal API.
- ACK occurs only after local materialization commits. A database reconciler repairs lost delivery; NATS is never the source of truth.

## Template Checklist

When extracting a new project template from this solution, include:

```text
docs/aicrm_desktop_event_communication_standard.md
template/skills/aicrm-solution/SKILL.md
template/skills/aicrm-solution/references/module-boundaries.md
template/skills/aicrm-solution/references/permission-data-scope.md
template/skills/aicrm-solution/references/api-contracts.md
template/skills/aicrm-solution/references/event-communication.md
template/skills/aicrm-solution/references/template-extraction.md
```

In this repository, the template source copy lives at `template/docs/aicrm_desktop_event_communication_standard.md`; after initializing a new independent project, keep it under root `docs/`.

After template extraction, verify:

- The copied skill still points to the copied communication document.
- Subscription examples still match the generated desktop bridge adapter.
- SSE remains Host-owned, and NATS remains backend-only after extraction.
- Command Ticket, device proof and sequence examples do not expose secrets or permit raw-ID local writes.
- No production domain, secret, token, cookie, local screenshot, or build artifact is included.
- `quick_validate.py` passes for the copied skill.
