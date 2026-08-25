import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, BookOpen, Bot, Clock3, Code2, FileText, FolderKanban, GitBranch, Loader2, MessageSquare, Network, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { projectApi } from '@/services/api';
import { readableApiError, unwrapApiData } from '@/services/runtimeSettings';
import { useNavigate } from 'react-router-dom';
import { projectContextPath, projectNavigationState } from '@/services/projectContext';

interface ProjectActivity { type: string; timestamp: string; changes?: Record<string, unknown> }
interface Project {
  _id: string;
  name: string;
  description?: string;
  tags: string[];
  status: 'active' | 'archived';
  activity?: ProjectActivity[];
  lastActivityAt?: string;
  updatedAt: string;
}

interface ProjectForm { name: string; description: string; tags: string }
const emptyForm: ProjectForm = { name: '', description: '', tags: '' };
const parseTags = (tags: string) => tags.split(',').map((tag) => tag.trim()).filter(Boolean);

export default function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Project>();
  const [form, setForm] = useState<ProjectForm>(emptyForm);
  const [selected, setSelected] = useState<Project>();
  const [deleteRequest, setDeleteRequest] = useState<{ project: Project; token: string }>();

  const load = useCallback(async () => {
    setLoading(true); setError(undefined);
    try {
      const response = await projectApi.list(filter);
      const data = unwrapApiData(response.data) as { projects?: Project[] };
      setProjects(Array.isArray(data?.projects) ? data.projects : []);
    } catch (loadError) {
      setError(readableApiError(loadError, 'Projects could not be loaded.'));
    } finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  const openCreate = () => { setEditing(undefined); setForm(emptyForm); setFormOpen(true); };
  const openEdit = (project: Project) => {
    setEditing(project);
    setForm({ name: project.name, description: project.description || '', tags: project.tags.join(', ') });
    setFormOpen(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const payload = { name: form.name.trim(), description: form.description.trim(), tags: parseTags(form.tags) };
      if (editing) await projectApi.update(editing._id, payload);
      else await projectApi.create(payload);
      toast.success(editing ? 'Project updated' : 'Project created');
      setFormOpen(false); setEditing(undefined); setForm(emptyForm);
      await load();
    } catch (saveError) { toast.error(readableApiError(saveError, 'Project could not be saved.')); }
    finally { setSaving(false); }
  };

  const toggleArchive = async (project: Project) => {
    try {
      if (project.status === 'archived') await projectApi.restore(project._id);
      else await projectApi.archive(project._id);
      toast.success(project.status === 'archived' ? 'Project restored' : 'Project archived');
      if (selected?._id === project._id) setSelected(undefined);
      await load();
    } catch (archiveError) { toast.error(readableApiError(archiveError, 'Project status could not be changed.')); }
  };

  const requestDelete = async (project: Project) => {
    try {
      const response = await projectApi.requestDeleteConfirmation(project._id);
      const data = unwrapApiData(response.data) as { confirmationToken?: string };
      if (!data.confirmationToken) throw new Error('Delete confirmation was not returned.');
      setDeleteRequest({ project, token: data.confirmationToken });
    } catch (deleteError) { toast.error(readableApiError(deleteError, 'Delete confirmation failed.')); }
  };

  const confirmDelete = async () => {
    if (!deleteRequest) return;
    try {
      await projectApi.delete(deleteRequest.project._id, deleteRequest.token);
      toast.success('Project deleted'); setDeleteRequest(undefined); setSelected(undefined); await load();
    } catch (deleteError) { toast.error(readableApiError(deleteError, 'Project deletion failed.')); }
  };

  const openProjectTool = (project: Project, path: '/app/chat' | '/app/code' | '/app/documents' | '/app/agents' | '/app/knowledge' | '/app/repositories' | '/app/workflows') => {
    const context = { projectId: project._id, projectName: project.name };
    navigate(projectContextPath(path, context), { state: projectNavigationState(context) });
  };

  return <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="flex items-center gap-3 text-3xl font-bold text-white"><FolderKanban className="text-primary" />Projects</h1><p className="mt-2 text-gray-400">Persistent, owner-scoped rooms for KFive work.</p></div><div className="flex gap-2"><button onClick={() => void load()} className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-gray-300"><RefreshCw className={`h-5 w-5 ${loading ? 'animate-spin' : ''}`} /></button><button onClick={openCreate} className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-white"><Plus className="h-4 w-4" />New project</button></div></div>
    <div className="flex gap-2">{(['active', 'archived', 'all'] as const).map((value) => <button key={value} onClick={() => setFilter(value)} className={`rounded-lg px-3 py-1.5 text-sm capitalize ${filter === value ? 'bg-primary text-white' : 'bg-white/5 text-gray-400'}`}>{value}</button>)}</div>
    {error ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-200">{error}</div> : null}
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]"><section className="grid gap-4 sm:grid-cols-2">{projects.map((project) => <article key={project._id} onClick={() => setSelected(project)} className="cursor-pointer rounded-2xl border border-white/10 bg-white/5 p-5 transition hover:border-primary/40"><div className="flex items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-white">{project.name}</h2><span className={`mt-2 inline-block rounded-full px-2 py-1 text-xs ${project.status === 'active' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-gray-500/10 text-gray-400'}`}>{project.status}</span></div><div className="flex"><button onClick={(event) => { event.stopPropagation(); openEdit(project); }} className="p-2 text-gray-500 hover:text-white"><Pencil className="h-4 w-4" /></button><button onClick={(event) => { event.stopPropagation(); void toggleArchive(project); }} className="p-2 text-gray-500 hover:text-amber-300">{project.status === 'archived' ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}</button><button onClick={(event) => { event.stopPropagation(); void requestDelete(project); }} className="p-2 text-gray-500 hover:text-red-300"><Trash2 className="h-4 w-4" /></button></div></div><p className="mt-3 line-clamp-3 text-sm text-gray-400">{project.description || 'No description'}</p><div className="mt-4 flex flex-wrap gap-2">{project.tags.map((tag) => <span key={tag} className="rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">{tag}</span>)}</div><p className="mt-4 flex items-center gap-1 text-xs text-gray-600"><Clock3 className="h-3 w-3" />{new Date(project.lastActivityAt || project.updatedAt).toLocaleString()}</p></article>)}{!loading && !projects.length ? <div className="col-span-full rounded-2xl border border-dashed border-white/10 p-10 text-center text-gray-500">No {filter === 'all' ? '' : filter} projects.</div> : null}</section>
      <aside className="rounded-2xl border border-white/10 bg-white/5 p-5"><h2 className="font-semibold text-white">Project room</h2>{selected ? <><p className="mt-1 text-sm text-primary">{selected.name}</p><div className="mt-4 grid gap-2"><button onClick={() => openProjectTool(selected, '/app/chat')} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white"><MessageSquare className="h-4 w-4" />New project chat</button><button onClick={() => openProjectTool(selected, '/app/code')} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200"><Code2 className="h-4 w-4" />Project code runs</button><button onClick={() => openProjectTool(selected, '/app/documents')} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200"><FileText className="h-4 w-4" />Project documents</button><button onClick={() => openProjectTool(selected, '/app/knowledge')} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200"><BookOpen className="h-4 w-4" />Project knowledge</button><button onClick={() => openProjectTool(selected, '/app/repositories')} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200"><GitBranch className="h-4 w-4" />Repository analyses</button><button onClick={() => openProjectTool(selected, '/app/workflows')} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200"><Network className="h-4 w-4" />Project workflows</button><button onClick={() => openProjectTool(selected, '/app/agents')} className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-200"><Bot className="h-4 w-4" />Project agents</button></div><h3 className="mt-6 text-sm font-semibold text-white">Activity</h3><div className="mt-3 space-y-3">{(selected.activity || []).slice().reverse().map((activity, index) => <div key={`${activity.timestamp}-${index}`} className="border-l border-white/10 pl-3"><p className="text-sm capitalize text-gray-300">{activity.type.replace(/-/g, ' ')}</p><p className="text-xs text-gray-600">{new Date(activity.timestamp).toLocaleString()}</p></div>)}{!selected.activity?.length ? <p className="text-sm text-gray-500">No activity reported.</p> : null}</div></> : <p className="mt-3 text-sm text-gray-500">Select a project to open its chat, code runs, documents, knowledge, repository analyses, workflows, agents, or activity.</p>}</aside></div>

    {formOpen ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"><form onSubmit={save} className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#11131d] p-6"><div className="flex items-center justify-between"><h2 className="text-xl font-semibold text-white">{editing ? 'Edit project' : 'Create project'}</h2><button type="button" onClick={() => setFormOpen(false)}><X className="text-gray-500" /></button></div><div className="mt-5 space-y-4"><label className="block text-sm text-gray-300">Name<input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" /></label><label className="block text-sm text-gray-300">Description<textarea maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} className="mt-1 min-h-24 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" /></label><label className="block text-sm text-gray-300">Tags, comma separated<input value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white" /></label></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setFormOpen(false)} className="rounded-lg border border-white/10 px-4 py-2 text-gray-300">Cancel</button><button disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 font-medium text-white disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}Save</button></div></form></div> : null}
    {deleteRequest ? <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4"><div className="max-w-md rounded-2xl border border-red-500/30 bg-[#11131d] p-6"><h2 className="text-xl font-semibold text-white">Delete project permanently?</h2><p className="mt-2 text-sm text-gray-400">Delete <strong className="text-white">{deleteRequest.project.name}</strong>? Associated-content deletion is not implied by this action.</p><div className="mt-5 flex justify-end gap-3"><button onClick={() => setDeleteRequest(undefined)} className="rounded-lg border border-white/10 px-4 py-2 text-gray-300">Cancel</button><button onClick={() => void confirmDelete()} className="rounded-lg bg-red-600 px-4 py-2 font-medium text-white">Confirm delete</button></div></div></div> : null}
  </div>;
}
