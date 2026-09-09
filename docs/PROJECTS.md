# Project Rooms

Project Rooms are persistent, owner-scoped containers for KFive work. The current experimental area supports project creation, editing, tags, active/archived state, bounded activity history, and explicit deletion confirmation. Its core browser/MongoDB lifecycle has passed; the larger Project Rooms specification is not complete.

## Current behavior

- Every project query is scoped to the authenticated user.
- A missing project and a project owned by another user return the same `PROJECT_NOT_FOUND` response.
- Activity records creation, rename, metadata update, archive, and restore events. The most recent 100 events are retained.
- Deletion requires a short-lived, one-use confirmation token bound to the user and project. Only a SHA-256 token digest is held by the backend process.
- New chats, code runs, uploaded documents, knowledge sources, repository analyses, agents, workflow definitions, datasets, notebooks, and benchmark runs may be associated with an active project. Archived project content remains listable/readable and project knowledge remains queryable. Archived Dataset Lab records remain readable and privately downloadable, but upload, derivation, and deletion are rejected until the project is restored. Archived Workflow and Notebook definitions/history are read-only: they cannot be edited, run, or deleted until the project is restored. Cancellation remains available only as a safe-shutdown action for an already-active or orphaned run.
- Project-document deletion shares the project mutation lease: archive/restore cannot race it, and an archived project is checked before either the file or Mongo record is removed. A retained orphan document can still be cleaned after non-cascading project deletion.
- Project deletion does not cascade into associated resources. This avoids surprising data loss; cascade/export policy remains to be designed. Repository-analysis reports remain discoverable in the owner's unscoped analyzer history and deletable even when their former project no longer exists. Non-cascaded terminal Workflow runs and then their definitions can also be deleted after the former project is gone so they do not permanently consume owner retention. Other resource types may not yet provide equivalent orphan-management behavior.

## API

All routes require authentication and use the `/api/v1/projects` prefix.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | List the current user's projects; `status=active`, `archived`, or `all` |
| `POST` | `/` | Create a project |
| `GET` | `/:id` | Read a project and its activity |
| `PATCH` | `/:id` | Rename or update description, tags, and state |
| `POST` | `/:id/archive` | Archive a project |
| `POST` | `/:id/restore` | Restore a project |
| `POST` | `/:id/delete-confirmation` | Issue a short-lived deletion token |
| `DELETE` | `/:id` | Delete the project using the confirmation token |

Chat, Code Run, document, Knowledge/RAG, Repository Analyzer, agent, Workflow, Dataset Lab, Notebook, and Benchmark create/list endpoints accept project context as documented by their API payloads. Project ownership and active state are validated server-side; a client-supplied identifier or display name is never trusted on its own. Workflow, dataset, notebook, and benchmark project associations are immutable after creation. Dataset derivation creates a distinct child rather than mutating its source, and a dataset parent with retained derived children cannot be deleted first.

## Run and verify

Start a healthy local stack, sign in, and open **Projects**. Create a project, edit its tags, open a project chat, upload a project document and dataset, create and privately download a derived dataset, archive the project and verify its datasets are read/download-only, restore it, then request and confirm deletion. Restart the application before deletion if testing persistence.

On 2026-09-04, a production-Compose real-browser run passed create/edit/tags/activity, canonical selected-room refresh, project-document upload/list, restart persistence, archive read-only behavior, archived-document delete rejection, restore/delete, guarded project deletion/reload, confirmation-token replay rejection, and direct plus forged project-scope rejection for a second real user. Automated service and route tests cover the failure branches around that path. Project Rooms still remain **Experimental** because export/import and the full lifecycle of every associated resource are incomplete.

## Known limitations

- Project export/import is not implemented.
- Project-specific Knowledge/RAG, Repository Analyzer reports, Code Run history, the fixed `Input -> Prompt -> LLM -> Output` Workflow, bounded CSV/JSON Dataset Lab, fixed-suite Model Benchmarks, and Notebook Mode are Experimental. Notebook's authenticated local execution/history and restart-persistence path has passed, but broader browser ownership, AppArmor, immutable-image, remote, and Kubernetes proof remains. Dataset Lab's 100-record and Benchmark's 100-run quotas apply across the owner rather than separately per project; their browser/auth/provider/Mongo/filesystem restart paths remain pending. Workflow's 100-definition and 500-run caps likewise apply across the owner, and its target-host browser/provider/Mongo path remains pending. General workflow automation, ML experiments/training, and a durable shared GPU queue remain planned.
- Activity is project metadata, not yet a unified audit feed for every associated resource action.
- Delete confirmations are process-local; restarting or scaling the backend invalidates outstanding confirmations.
