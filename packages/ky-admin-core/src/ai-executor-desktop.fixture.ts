import type { CodexModelCatalogSnapshot } from "./ai-executor-desktop";

/** Compile-time fixture shared by contract tests; contains no production data. */
export const CODEX_MODEL_CATALOG_CONTRACT_FIXTURE = {
  executorId: "aiexec_fixture",
  credentialRevision: 1,
  catalogRevision: 2,
  observedAt: "2026-01-01T00:00:00.000Z",
  models: [
    {
      modelKey: "codex-fixture",
      displayName: "Codex Fixture",
      inputModalities: ["text"],
      supportedReasoningEfforts: ["medium"],
      hidden: false,
      status: "available"
    }
  ]
} satisfies CodexModelCatalogSnapshot;
