# Remove Gemini — Experiential Labs Gateway Only

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cadai single-provider. Every model call goes to the Experiential Labs gateway over the OpenAI wire format, authenticated server-side with `EXPLABS_API_KEY`. Google Gemini, the `@langchain/google-genai` and `@google/generative-ai` dependencies, `GOOGLE_API_KEY`/`GEMINI_API_KEY`, and the browser-supplied user API key are all removed.

**Architecture:** `getChatModel` loses its provider fork and always returns a `ChatOpenAI` pointed at `EXPLABS_BASE_URL`, so `CadChatModel` collapses from a union to a single class. Because gateway models authenticate server-side and that key is never sent to the browser, removing the Google lane removes user-supplied keys from the entire application: the `apiKey` parameter is deleted from `createCadAgent`, both API routes, the chat panel, and the app store, and the header's key modal is deleted outright. The model picker becomes a flat list of gateway slugs. A read-time coercion in thread storage keeps already-persisted threads openable.

**Tech Stack:** Next.js 16 (App Router, Node runtime), LangGraph 1.x, `@langchain/openai`, zod 4, vitest 4, Langfuse v5.

**Prerequisite for:** the prior-art research layer design, which is parked until this lands.

## Global Constraints

- `EXPLABS_API_KEY` must be set for the app to run at all after this change. There is no second lane and no fallback.
- The JSON Schema sent to the model must still not contain `prefixItems`, `oneOf`, `not`, `additionalItems` or `$ref`, and every `{"type":"number"}` must stay bounded by `boundNumbers` in `src/lib/agent/assembly-spec.ts`. **This constraint survives Gemini.** Its own comment records that decoder degeneration was "first seen on Gemini and later reproduced on DeepSeek", and the measured evidence (6/10 valid and 114 s unbounded against 8/10 and 78 s bounded) was taken on `deepseek-v4-flash`. Rewrite the justifications that name Gemini; never relax the rule.
- `Vec3` stays `z.array(z.number()).length(3)`, not `z.tuple()`. Avoiding `prefixItems` began as a Google constraint, but a length-constrained array works on every provider, so there is nothing to simplify.
- Tests never call a real model. Every graph suite already mocks both `@langchain/google-genai` and `@langchain/openai`; only the Google block is removed.
- Nothing raw from a model may reach the UI.
- No commit touches `.env`, `.env.local`, or `.cadai/`.
- Run the whole suite with `npm test` (vitest run). Wasm suites are slow; `testTimeout` is 30 s.
- Work on branch `claude/busy-morse-9b2d33`. Commit after every task, ending the message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Each task must leave `npm test` green before it is committed, and must add **no new** `npm run lint` problems. Lint is not green on this repo: `main` already reports 102 problems (83 errors, 19 warnings), almost all `@typescript-eslint/no-explicit-any`. Compare against that baseline rather than chasing zero, and do not fold an unrelated lint cleanup into this work.

---

## Phase 0 — Protect existing data before anything can break

### Task 1: Coerce stale model slugs at thread load

Persisted threads carry `selectedModel: 'gemini-3.6-flash'`. Once the Google lane is gone those slugs reach `getChatModel` and fail, so **every existing thread would break on open**. This coercion must land before the provider change, not after.

**Files:**
- Modify: `src/lib/storage/thread-storage.ts`
- Test: `src/lib/storage/thread-storage.test.ts`

**Interfaces:**
- Produces: a read-time normalisation applied wherever a stored thread is hydrated. Any `selectedModel` that is absent, empty, or not a known gateway slug loads as `DEFAULT_TEXT_MODEL`. Exported as `coerceModelSlug(slug: string | undefined): string` so the test can hit it directly.

- [ ] **Step 1:** Write failing tests — a thread stored with `gemini-3.6-flash` hydrates with `deepseek-v4-flash`; a thread stored with `deepseek-v4-pro` keeps it; an absent slug becomes the default.
- [ ] **Step 2:** Implement `coerceModelSlug` and apply it on the hydrate path.
- [ ] **Step 3:** Change the default at `src/lib/storage/thread-storage.ts:52` from `'gemini-3.6-flash'` to `DEFAULT_TEXT_MODEL`.
- [ ] **Step 4:** `npm test` green, then commit.

---

## Phase 1 — Collapse the provider layer

### Task 2: One lane in `model-provider.ts`, and the `createCadAgent` signature

Atomic: deleting the `apiKey` parameter from `getChatModel` breaks `createCadAgent`, which breaks roughly 40 call sites. Splitting this leaves the tree red between commits, so it is one task.

**Files:**
- Modify: `src/lib/agent/model-provider.ts`, `src/lib/agent/model-provider.test.ts`, `src/lib/agent/graph.ts`
- Modify (call sites): `src/app/api/chat/route.ts`, `src/app/api/chat/resume/route.ts`, `eval/generation/run.ts`
- Modify (mocks and call sites): `src/lib/agent/graph-hil.test.ts`, `src/lib/agent/graph-placement.test.ts`, `src/lib/agent/graph-critic.test.ts`

**Interfaces:**
- Produces: `getChatModel(modelName?: string): ChatOpenAI`, `getVisionModel(modelName?: string): ChatOpenAI`, `type CadChatModel = ChatOpenAI`, `createCadAgent(onProgress?, modelName?)`.
- Removes: `isGeminiSlug`, `googleKey`, `supportsVision`, `getGeminiModel`.

- [ ] **Step 1:** Rewrite `model-provider.test.ts` first. Delete the five Gemini cases. Keep and adapt: gateway slug returns `ChatOpenAI` with the right `baseURL`; the default is `deepseek-v4-flash`; `CADAI_MODEL` overrides the default; a missing `EXPLABS_API_KEY` throws naming that variable; vision falls back to `DEFAULT_VISION_MODEL`; `CADAI_VISION_MODEL` is honoured. Add: `getVisionModel` reuses the selected model when it already **is** `DEFAULT_VISION_MODEL` rather than re-resolving.
- [ ] **Step 2:** Collapse `model-provider.ts` — delete `isGeminiSlug`, `googleKey`, both provider branches, and `supportsVision` (it has no production caller, only its own test). Narrow `CadChatModel` to `ChatOpenAI`. Drop the `apiKey` parameter from both factories and rewrite the module doc comment, which currently explains a two-lane split that no longer exists.
- [ ] **Step 3:** In `graph.ts`, drop the `ChatGoogleGenerativeAI` import (line 2), delete `getGeminiModel` (lines 478-480, no caller), and change `createCadAgent(apiKey, onProgress, modelName)` to `createCadAgent(onProgress, modelName)`, updating its two internal factory calls.
- [ ] **Step 4:** Rewrite the comment at `src/lib/agent/graph.ts:844`. The rule — never accumulate a `SystemMessage` into `messages` — **stays**, because every node prepends its own fresh system message; only the Google-client justification goes.
- [ ] **Step 5:** Update every `createCadAgent` call site: both API routes, `eval/generation/run.ts:67`, and the 36 in the three graph suites (`graph-hil` 16, `graph-placement` 14, `graph-critic` 6) — drop the leading `'k'` / `'test-key'` argument.
- [ ] **Step 6:** Delete the `vi.mock('@langchain/google-genai', ...)` block from all three graph suites. They already mock `@langchain/openai`, so nothing else changes. Update the stale comments above those mocks that describe slug-based provider routing.
- [ ] **Step 7:** `npm run lint` and `npm test` green, then commit.

---

## Phase 2 — Remove user-supplied keys from the client

### Task 3: Delete the `apiKey` chain and rebuild the model picker

**Files:**
- Modify: `src/store/app-store.ts`, `src/components/layout/header.tsx`, `src/components/chat/chat-panel.tsx`, `src/app/api/chat/route.ts`, `src/app/api/chat/resume/route.ts`

**Interfaces:**
- Removes: `apiKey` from the store (field, initial value, `setApiKey`), the key button and its modal from the header, `apiKey` from both fetch bodies, and `apiKey` from both route request types.
- Produces: a flat model `select` with five options — `deepseek-v4-flash` (recommended default), `deepseek-v4-pro`, `deepseek-v3.1`, `deepseek-v3.2`, `gpt-5.6-luna`.

- [ ] **Step 1:** `src/store/app-store.ts` — remove the `apiKey` field (line 21), its initial value (line 93) and `setApiKey` (line 245).
- [ ] **Step 2:** `src/components/layout/header.tsx` — delete the key button, the whole modal, the `showKeyModal` and `tempKey` state, and the now-unused `Key` icon import. Replace the two Gemini optgroups and the gateway optgroup with a flat five-option list; drop the optgroups entirely, since one lane makes them noise. Rewrite the `title` attribute, which still describes Gemini using your own key.
- [ ] **Step 3:** `src/components/chat/chat-panel.tsx` — remove the `apiKey` store read (line 36) and both `apiKey:` fetch body fields (lines 161, 311). Rewrite the error message at line 259, which tells the user to check their Google Gemini API key.
- [ ] **Step 4:** Both routes — drop `apiKey` from the destructure and the body type, and stop passing it to `createCadAgent`. Replace the `model || 'gemini-3.6-flash'` fallbacks in the Langfuse tags and metadata (lines 79 and 81 in each) with `DEFAULT_TEXT_MODEL`.
- [ ] **Step 5:** Confirm `gpt-5.6-luna` still resolves correctly through `getVisionModel` now that it is also selectable as a text model. `deepseek-v4-flash-vision-exp` stays off the list: the gateway refuses `response_format` on that profile, so the Visual Critic cannot use it.
- [ ] **Step 6:** `npm run lint` and `npm test` green, then commit.

---

## Phase 3 — Dependencies and documentation

### Task 4: Drop the packages and rewrite the Gemini-era comments

**Files:**
- Modify: `package.json`, `vitest.setup.ts`, `src/lib/tracing/langfuse.ts`, `README.md`, `src/lib/agent/assembly-spec.ts`, `src/lib/agent/assembly-spec.test.ts`

- [ ] **Step 1:** Remove `@langchain/google-genai` and `@google/generative-ai` from `package.json`, then `npm install` to update the lockfile.
- [ ] **Step 2:** `vitest.setup.ts:10` — delete the `GOOGLE_API_KEY` placeholder, keep the `EXPLABS_API_KEY` one.
- [ ] **Step 3:** `src/lib/tracing/langfuse.ts:85` — change the default tag `'gemini'` to `'explabs'`.
- [ ] **Step 4:** `README.md:68` — "LangGraph & Google Gemini" becomes the gateway wording. Scan the rest of the README for any setup step that still tells a reader to supply a Google key.
- [ ] **Step 5:** Rename the guard test at `src/lib/agent/assembly-spec.test.ts:65` from "emits no JSON Schema keyword Gemini rejects" to a provider-neutral name, and rewrite the block comment above it. **Keep the assertions unchanged** — they are what keeps `Vec3` a length-3 array and the schema inside a conservative subset.
- [ ] **Step 6:** Rewrite the `Vec3` comment in `src/lib/agent/assembly-spec.ts:7` so it explains the `prefixItems` avoidance as a portability choice rather than a Gemini workaround. Leave the `boundNumbers` comment at line 162 alone; it already names both providers and its evidence is DeepSeek evidence.
- [ ] **Step 7:** `npm run lint` and `npm test` green, then commit.

---

## Phase 4 — Verify

### Task 5: Prove nothing Google-shaped is left

- [ ] **Step 1:** `npm run lint` — clean.
- [ ] **Step 2:** `npm test` — the full suite green. Record the pass count.
- [ ] **Step 3:** Run the sweep. The only expected hit is the deliberate coercion in `thread-storage.ts`:

```bash
grep -rn "gemini\|google-genai\|generative-ai\|GOOGLE_API_KEY\|GEMINI_API_KEY\|ChatGoogleGenerativeAI" -i --include=*.ts --include=*.tsx --include=*.json --include=*.md src eval README.md package.json
```

- [ ] **Step 4:** `npm run build` — confirm the production build succeeds with the dependencies gone.
- [ ] **Step 5:** Start the dev server and open an existing thread that was saved with a `gemini-*` slug. It must load and run on `deepseek-v4-flash` rather than erroring. This is the one behaviour no unit test fully covers.
- [ ] **Step 6:** Commit, then unpark the prior-art research layer design.
