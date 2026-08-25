# Project Rooms

Project Rooms are persistent, owner-scoped containers for KFive work. The current experimental slice supports project creation, editing, tags, active/archived state, bounded activity history, and explicit deletion confirmation.

## Current behavior

- Every project query is scoped to the authenticated user.
- A missing project and a project owned by another user return the same `PROJECT_NOT_FOUND` response.
- Activity records creation, rename, metadata update, archive, and restore events. The most recent 100 events are retained.
- Deletion requires a short-lived, one-use confirmation token bound to the user and project. Only a SHA-256 token digest is held by the backend process.
- New chats, code runs, uploaded documents, knowledge sources, repository analyses, agents, and Phase 10 workflow definitions may be associated with an active project. Archived project content remains listable/readable and project knowledge remains queryable, but new associations and mutating actions are rejected. Archived workflow definitions and run history are read-only: they cannot be edited, run, or deleted until the project is restored. Cancellation remains available only as a safe-shutdown action for an already-active or orphaned workflow run.
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

Chat, Code Run, document, Knowledge/RAG, Repository Analyzer, agent, and Workflow create/list endpoints accept project context as documented by their API payloads. Project ownership and active state are validated server-side; a client-supplied identifier or display name is never trusted on its own. A workflow's optional project association is immutable after creation.

## Run and verify

Start a healthy local stack, sign in, and open **Projects**. Create a project, edit its tags, open a project chat, upload a project document, archive and restore it, then request and confirm deletion. Restart the application before deletion if testing persistence.

Automated service and route tests do not replace the MongoDB/browser end-to-end check. Until that live path is executed, Project Rooms remain **Experimental**.

## Known limitations

- Project export/import is not implemented.
- Project-specific Knowledge/RAG, Repository Analyzer reports, and Code Run history exist as Experimental slices. The fixed `Input -> Prompt -> LLM -> Output` Workflow slice is Experimental and still being implemented; its 100-definition and 500-run caps apply across the owner, not separately to each project, and its target-host browser/provider/Mongo path remains pending. General workflow automation, datasets, experiments, and benchmarks remain planned.
- Activity is project metadata, not yet a unified audit feed for every associated resource action.
- Delete confirmations are process-local; restarting or scaling the backend invalidates outstanding confirmations.
