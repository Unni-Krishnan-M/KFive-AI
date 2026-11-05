# Workflow live verification — 2026-09-21

Scope: the local, workspace-scoped, single-backend-replica fixed `Input -> Prompt -> LLM -> Output` slice. This does not verify a general visual workflow engine, additional node types, distributed execution, remote providers, project archive behavior, or Kubernetes.

## Production path

- Production frontend: `http://127.0.0.1:3002`
- A disposable account created a workflow through the real browser UI. The model selector exposed only chat-capable `phi3:latest`; embedding-only `all-minilm:22m` was excluded.
- Workflow definition: `Reply with exactly {{input}} and nothing else.` with inert text output.
- Successful browser run: `6ab1681ddd440a87811252d5`
  - input: `WORKFLOW_SUCCESS_92126`
  - terminal status: `succeeded`
  - output: `WORKFLOW_SUCCESS_92126`
  - provider/model: `ollama` / `phi3:latest`
  - timeline: `created`, `started`, `provider selected`, `completed`
- Cancelled browser run: `6ab16837dd440a87811252e9`
  - cancellation was clicked through the real **Cancel run** control immediately after **Run workflow** became active
  - terminal status: `cancelled`
  - timeline rendered in canonical order: `created`, `started`, `cancel requested`, `cancelled`
- The backend container was restarted and returned to `running healthy`. After a full browser reload, the UI reopened the workflow and found both exact Mongo-backed run IDs/statuses, then re-read `WORKFLOW_SUCCESS_92126` from successful run detail.
- Both runs and the workflow were deleted through confirmed UI actions. Exact Mongo cleanup then reported `{users:1, workflows:0, runs:0}`, deleted the disposable user, and rechecked `{usersAfter:0, workflowsAfter:0, runsAfter:0}`.
- Final cancellation-readiness acceptance after redeployment used run `6ab16f5940f6fd4df740509d`. The browser observed disabled **Starting…**, then **Cancel run** only after the durable run id arrived, and finally `cancelled` with `created`, `started`, `cancel requested`, `cancelled`. After a backend restart, selecting the workflow recovered the same run id and status from MongoDB. Exact fixture cleanup deleted one run, one workflow, and one user and confirmed zero remaining records for that owner.

This exercised browser → authenticated Nginx/API → provider SSE → Unix-socket host-Ollama bridge → local Ollama → MongoDB definition/detail/history, plus server-side cancellation and backend-restart persistence. An initial model-catalog 502 exposed that a narrow container recreation had omitted the host-Ollama override. Reapplying the supported `kfive-up --with-host-ollama` deployment restored the bridge configuration, after which the same browser path passed. The only remaining browser console resource errors were external Google Fonts certificate failures.

## Relevant regression results

- Backend Workflow suites: **4 suites, 33 tests passed**.
  - `src/models/workflow.test.ts`
  - `src/routes/workflows.test.ts`
  - `src/services/workflowRunService.test.ts`
  - `src/services/workflowService.test.ts`
- Frontend Workflow/model/transport/Nginx suites: **4 files, 18 tests passed**.
  - `src/services/workflowModel.test.ts`
  - `src/services/modelManager.test.ts`
  - `src/services/apiTransport.test.ts`
  - `src/config/nginxProxy.test.ts`
- Backend TypeScript production build: passed.
- Frontend TypeScript/Vite production build: passed.
- Backend and frontend runtime layers were built from cached production images because Docker registry TLS validation was unavailable; both deployed containers became healthy without resetting persistent volumes.

## Remaining limits

Execution remains intentionally single-replica and in-process. Only the fixed four-node text graph exists; all advertised planned nodes remain disabled. Multi-replica leases, cross-process cancellation, durable queued execution/resumption, atomic quotas, live timeout/output-limit acceptance, project archive/second-owner browser acceptance, remote providers, and Kubernetes remain unverified or planned.
