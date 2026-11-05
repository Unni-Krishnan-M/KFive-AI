# Agent Runtime live verification — 2026-09-21

Scope: the local, single-backend-replica Agent Runtime critical path. This does not verify distributed execution, tool use, approvals, remote providers, or Kubernetes.

## Production path

- Production frontend: `http://127.0.0.1:3002`
- Authenticated disposable browser user and Agent were retained across a full stack stop/start.
- The Agent was edited through the UI from an embedding-only legacy model to the installed chat model `phi3:latest`. The deployed selector listed `all-minilm:22m` only as the current legacy value and listed `phi3:latest` as the chat-capable choice.
- Successful browser run: `6ab16197859c35a0c874ac4a`
  - prompt: `Reply with exactly BROWSER_AGENT_SUCCESS_92126 and nothing else.`
  - terminal status: `succeeded`
  - output: `BROWSER_AGENT_SUCCESS_92126`
  - provider/model: `ollama` / `phi3:latest`
  - timeline: `created`, `started`, `provider selected`, `completed`
- Cancelled browser run: `6ab161e3859c35a0c874ac7c`
  - cancellation was clicked through the real **Cancel run** control immediately after **Run Agent** became active
  - terminal status: `cancelled`
  - timeline: `created`, `started`, `cancel requested`, `cancelled`
- The backend container was restarted and reported `running healthy`. After a full browser reload, the UI reopened Mongo-backed history, found both exact run IDs/statuses, and re-read `BROWSER_AGENT_SUCCESS_92126` from the successful run detail.
- All three disposable runs (including one earlier timing attempt) and the Agent were deleted through the UI. An exact Mongo query then reported `{users:1, agents:0, runs:0}`; the disposable user was deleted and the final check reported `{usersAfter:0, agentsAfter:0, runsAfter:0}`.

This exercised browser → authenticated Nginx/API → provider SSE → local Ollama → MongoDB detail/history, plus server-side cancellation and backend-restart persistence. The only browser console resource errors were the already-known external Google Fonts certificate failures; application requests used the local production proxy.

## Relevant regression results

- Backend Agent suites: **5 suites, 37 tests passed**.
  - `src/models/agentRun.test.ts`
  - `src/routes/agentRuns.test.ts`
  - `src/routes/agentUpdate.test.ts`
  - `src/services/agentRunService.test.ts`
  - `src/services/agentService.test.ts`
- Frontend Agent/SSE/model/Nginx suites: **4 files, 21 tests passed**.
  - `src/services/modelManager.test.ts`
  - `src/services/agentModel.test.ts`
  - `src/utils/sse.test.ts`
  - `src/config/nginxProxy.test.ts`
- Backend TypeScript production build: passed.
- Frontend TypeScript/Vite production build: passed.
- The deployed frontend runtime image was rebuilt from the cached production image because the host Docker registry request failed certificate validation. The resulting immutable image was recreated and became healthy; no volume was reset.

## Remaining limits

Agent execution is still intentionally single-replica and in-process. Tools remain disabled, so approval workflows and tool isolation are not implemented. Multi-replica leases, cross-process cancellation, durable queued execution/resumption, atomic quotas, age-based/bulk retention, remote-provider acceptance, and Kubernetes acceptance remain unverified or planned.
