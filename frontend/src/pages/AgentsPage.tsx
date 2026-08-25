import { FormEvent, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Bot, Clock3, Edit2, FolderKanban, Loader2, Play, Plus, Search, Settings, StopCircle, Terminal, Trash2, Wrench, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { SlideOver } from '@/components/ui/SlideOver';
import { apiUrl } from '@/config/runtime';
import { useProjectContext } from '@/hooks/useProjectContext';
import {
  AGENT_RUN_OUTPUT_BYTES,
  AGENT_RUN_OWNER_RETENTION,
  AgentDraft,
  AgentRunDetail,
  AgentRunPagination,
  AgentRunSummary,
  AgentView,
  buildAgentPayload,
  normalizeAgent,
  normalizeAgentRunDetail,
  normalizeAgentRunDeletion,
  normalizeAgentRunPage,
  normalizeAgentRunUsage,
  isTerminalAgentRun,
} from '@/services/agentModel';
import { agentApi, modelApi } from '@/services/api';
import { ModelCatalog, normalizeModelCatalog } from '@/services/modelManager';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { readableApiError } from '@/services/runtimeSettings';
import { getToken } from '@/utils/getToken';
import { readSseResponse } from '@/utils/sse';

const TEMPLATES = [
  { name: 'Code Reviewer', description: 'Expert developer that reviews code for bugs and best practices.', systemPrompt: 'You are an expert software engineer. Review the provided code for bugs, anti-patterns, security issues, and performance bottlenecks. Suggest improvements.', aiModel: 'deepseek-coder', temperature: 0.2 },
  { name: 'Technical Writer', description: 'Creates clear, concise documentation from technical specs.', systemPrompt: 'You are a professional technical writer. Transform technical notes and code into clear, well-structured documentation suitable for developers.', aiModel: 'llama3', temperature: 0.5 },
  { name: 'Data Analyst', description: 'Analyzes data structures and suggests insights.', systemPrompt: 'You are a data analyst AI. Analyze the provided data structures or datasets. Identify patterns, anomalies, and provide actionable insights.', aiModel: 'mistral', temperature: 0.3 },
];

const emptyCatalog: ModelCatalog = { provider: 'unknown', modelScope: 'unknown', canPull: false, canDelete: false, models: [] };
const emptyRunPagination: AgentRunPagination = { page: 1, pageSize: 50, total: 0, totalPages: 1 };
const utf8 = new TextEncoder();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const dateTime = (value?: string) => value ? new Date(value).toLocaleString() : 'Pending';
const statusLabel = (status: string) => status.replace(/[_-]/g, ' ');
const activeStatus = (status?: string) => status === 'queued' || status === 'running' || status === 'cancel-requested';

interface ActiveExecution {
  agentId: string;
  controller: AbortController;
  request: number;
  runId?: string;
  hasRunRecord?: boolean;
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const { requested: projectRequested, context: projectContext, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = projectContext?.projectId;
  const projectScopeReady = !projectRequested || Boolean(projectContext);
  const projectMutationsAllowed = projectScopeReady && projectContext?.status !== 'archived';
  const scopeKey = projectId ?? (projectScopeReady ? 'all' : 'unresolved');
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  const [agents, setAgents] = useState<AgentView[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog>(emptyCatalog);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSlideOverOpen, setIsSlideOverOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDraft | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [agentToDelete, setAgentToDelete] = useState<string | null>(null);

  const [isExecuteModalOpen, setIsExecuteModalOpen] = useState(false);
  const [executingAgent, setExecutingAgent] = useState<AgentView | null>(null);
  const selectedAgentRef = useRef<string>();
  const [executePrompt, setExecutePrompt] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [recentRuns, setRecentRuns] = useState<AgentRunSummary[]>([]);
  const [runPagination, setRunPagination] = useState<AgentRunPagination>(emptyRunPagination);
  const [selectedRun, setSelectedRun] = useState<AgentRunDetail>();
  const [runsLoading, setRunsLoading] = useState(false);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runToDelete, setRunToDelete] = useState<AgentRunSummary>();
  const [runDeleting, setRunDeleting] = useState(false);
  const runDeleteInFlight = useRef(false);
  const streamedOutput = useRef('');
  const activeExecution = useRef<ActiveExecution>();
  const executionRequest = useRef(0);
  const agentListRequest = useRef(0);
  const runListRequest = useRef(0);
  const runDetailRequest = useRef(0);

  useEffect(() => {
    const request = ++agentListRequest.current;
    const requestedScope = scopeKey;
    if (!projectScopeReady) {
      setAgents([]);
      return;
    }
    void agentApi.getAgents(projectId).then((response) => {
      if (request !== agentListRequest.current || requestedScope !== scopeRef.current) return;
      const items: unknown[] = Array.isArray(response.data?.data) ? response.data.data : [];
      setAgents(items.map(normalizeAgent).filter((agent): agent is AgentView => Boolean(agent)));
    }).catch((error) => {
      if (request === agentListRequest.current && requestedScope === scopeRef.current) toast.error(readableApiError(error, 'Failed to fetch agents.'));
    });
  }, [projectId, projectScopeReady, scopeKey]);

  useEffect(() => {
    let current = true;
    void modelApi.getCatalog().then((response) => {
      if (current) setCatalog(normalizeModelCatalog(response.data));
    }).catch(() => {
      if (current) setCatalog(emptyCatalog);
    });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    const active = activeExecution.current;
    if (!active) return;
    if (active.runId) void agentApi.cancelRun(active.agentId, active.runId).finally(() => active.controller.abort());
    else active.controller.abort();
    activeExecution.current = undefined;
    setIsExecuting(false);
  }, [scopeKey]);

  useEffect(() => () => {
    const active = activeExecution.current;
    if (!active) return;
    if (active.runId) void agentApi.cancelRun(active.agentId, active.runId).finally(() => active.controller.abort());
    else active.controller.abort();
  }, []);

  const fetchAgents = async () => {
    const request = ++agentListRequest.current;
    const requestedScope = scopeRef.current;
    try {
      const response = await agentApi.getAgents(projectId);
      if (request !== agentListRequest.current || requestedScope !== scopeRef.current) return;
      const items: unknown[] = Array.isArray(response.data?.data) ? response.data.data : [];
      setAgents(items.map(normalizeAgent).filter((agent): agent is AgentView => Boolean(agent)));
    } catch (error) {
      if (request === agentListRequest.current && requestedScope === scopeRef.current) toast.error(readableApiError(error, 'Failed to fetch agents.'));
    }
  };

  const loadRuns = async (agentId: string, page = 1) => {
    const request = ++runListRequest.current;
    const requestedScope = scopeRef.current;
    setRunsLoading(true);
    try {
      const response = await agentApi.getRuns(agentId, page);
      const runPage = normalizeAgentRunPage(response.data);
      if (!runPage) throw new Error('The server returned invalid run pagination.');
      if (request !== runListRequest.current || requestedScope !== scopeRef.current || selectedAgentRef.current !== agentId) return;
      setRecentRuns(runPage.runs);
      setRunPagination(runPage.pagination);
    } catch (error) {
      if (request === runListRequest.current && selectedAgentRef.current === agentId) toast.error(readableApiError(error, 'Run history is unavailable.'));
    } finally {
      if (request === runListRequest.current) setRunsLoading(false);
    }
  };

  const loadRunDetail = async (agentId: string, runId: string) => {
    const request = ++runDetailRequest.current;
    const requestedScope = scopeRef.current;
    setRunDetailLoading(true);
    try {
      const response = await agentApi.getRun(agentId, runId);
      const detail = normalizeAgentRunDetail(response.data);
      if (!detail) throw new Error('The server returned an invalid agent run.');
      if (request !== runDetailRequest.current || requestedScope !== scopeRef.current || selectedAgentRef.current !== agentId) return;
      setSelectedRun(detail);
    } catch (error) {
      if (request === runDetailRequest.current && selectedAgentRef.current === agentId) toast.error(readableApiError(error, 'Run details are unavailable.'));
    } finally {
      if (request === runDetailRequest.current) setRunDetailLoading(false);
    }
  };

  const openExecution = (agent: AgentView) => {
    selectedAgentRef.current = agent.id;
    setExecutingAgent(agent);
    setExecutePrompt('');
    setSelectedRun(undefined);
    setRecentRuns([]);
    setRunPagination(emptyRunPagination);
    setIsExecuteModalOpen(true);
    void loadRuns(agent.id, 1);
  };

  const handleSaveAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingAgent?.name || !editingAgent.systemPrompt) return toast.error('Name and System Prompt are required');
    if (!projectMutationsAllowed) return toast.error(projectError || PROJECT_ARCHIVED_MESSAGE);
    try {
      const payload = buildAgentPayload(editingAgent, projectId);
      if (editingAgent.id) {
        await agentApi.updateAgent(editingAgent.id, payload);
        toast.success(`Updated agent: ${editingAgent.name}`);
      } else {
        await agentApi.createAgent(payload);
        toast.success(projectContext ? `Agent created in ${projectContext.projectName}` : 'Agent created successfully');
      }
      await fetchAgents();
      setIsSlideOverOpen(false);
    } catch (error) {
      toast.error(readableApiError(error, 'Failed to save agent.'));
    }
  };

  const confirmDelete = async () => {
    if (!agentToDelete || !projectMutationsAllowed) return;
    try {
      await agentApi.deleteAgent(agentToDelete);
      setAgents((current) => current.filter((agent) => agent.id !== agentToDelete));
      toast.success('Agent deleted');
    } catch (error) {
      toast.error(readableApiError(error, 'Failed to delete agent.'));
    } finally {
      setDeleteConfirmOpen(false);
      setAgentToDelete(null);
    }
  };

  const confirmRunDelete = async () => {
    const agentId = selectedAgentRef.current;
    const run = runToDelete;
    if (!agentId || !run || !isTerminalAgentRun(run) || !projectMutationsAllowed || runDeleteInFlight.current) return;
    runDeleteInFlight.current = true;
    setRunDeleting(true);
    try {
      const response = await agentApi.deleteRun(agentId, run.id);
      const deleted = normalizeAgentRunDeletion(response.data);
      if (!deleted || deleted.runId !== run.id) throw new Error('The server returned an invalid run deletion result.');
      if (selectedRun?.id === run.id) setSelectedRun(undefined);
      const targetPage = recentRuns.length === 1 && runPagination.page > 1 ? runPagination.page - 1 : runPagination.page;
      const remainingTotal = Math.max(0, runPagination.total - 1);
      setRecentRuns((current) => current.filter((item) => item.id !== run.id));
      setRunPagination((current) => ({ ...current, page: targetPage, total: remainingTotal, totalPages: Math.max(1, Math.ceil(remainingTotal / current.pageSize)) }));
      setRunToDelete(undefined);
      await loadRuns(agentId, targetPage);
      toast.success('Run deleted. One retained-run slot is available again.');
    } catch (error) {
      toast.error(readableApiError(error, 'Failed to delete the run.'));
    } finally {
      runDeleteInFlight.current = false;
      setRunDeleting(false);
    }
  };

  const cancelExecution = async (active: ActiveExecution) => {
    try {
      if (active.runId) await agentApi.cancelRun(active.agentId, active.runId);
    } catch (error) {
      toast.error(readableApiError(error, 'The run cancellation request failed.'));
    } finally {
      active.controller.abort();
      if (activeExecution.current === active) {
        activeExecution.current = undefined;
        setIsExecuting(false);
      }
    }
  };

  const stopExecution = async () => {
    const active = activeExecution.current;
    if (active) await cancelExecution(active);
  };

  const closeExecution = async () => {
    await stopExecution();
    selectedAgentRef.current = undefined;
    runListRequest.current += 1;
    runDetailRequest.current += 1;
    if (!runDeleteInFlight.current) setRunToDelete(undefined);
    setIsExecuteModalOpen(false);
  };

  const handleExecute = async () => {
    if (!executingAgent || !executePrompt.trim()) return;
    if (executingAgent.toolState === 'legacy-blocked') return toast.error('Reset this legacy agent’s disabled tools before running it.');
    if (!projectMutationsAllowed) return toast.error(projectError || PROJECT_ARCHIVED_MESSAGE);
    if (activeExecution.current) await cancelExecution(activeExecution.current);
    const token = getToken();
    if (!token) return toast.error('Authentication is required.');

    const controller = new AbortController();
    const active: ActiveExecution = { agentId: executingAgent.id, controller, request: ++executionRequest.current };
    const requestedScope = scopeRef.current;
    activeExecution.current = active;
    setIsExecuting(true);
    setSelectedRun(undefined);
    streamedOutput.current = '';

    const isCurrent = () => activeExecution.current === active && executionRequest.current === active.request && scopeRef.current === requestedScope && selectedAgentRef.current === active.agentId;
    try {
      const response = await fetch(apiUrl(`/agents/${active.agentId}/runs`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: executePrompt }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new Error(readableApiError({ response: { data: payload } }, `Agent execution failed with HTTP ${response.status}.`));
      }

      await readSseResponse(response, (data, eventName) => {
        if (!isCurrent()) return;
        if (!eventName && data === '[DONE]') return;
        if (!eventName) throw new Error('The agent stream returned an unnamed event.');
        const payload = JSON.parse(data) as unknown;
        const event = record(payload);
        if (eventName === 'run' || eventName === 'completed') {
          const detail = normalizeAgentRunDetail(payload);
          if (!detail || detail.agentId !== active.agentId) throw new Error('The agent stream returned an invalid run record.');
          if (active.runId && active.runId !== detail.id) throw new Error('The agent stream changed run identifiers.');
          active.runId = detail.id;
          active.hasRunRecord = true;
          streamedOutput.current = detail.output;
          setSelectedRun(detail);
        } else if (eventName === 'start') {
          if (typeof event.runId !== 'string' || event.runId.length > 128 || typeof event.provider !== 'string' || event.provider.length > 100 || typeof event.model !== 'string' || event.model.length > 200) throw new Error('The agent stream returned invalid provider metadata.');
          if (active.runId && active.runId !== event.runId) throw new Error('The agent stream changed run identifiers.');
          active.runId = event.runId;
          setSelectedRun((current) => current && current.id === event.runId ? { ...current, status: 'running', provider: event.provider as string, model: event.model as string } : current);
        } else if (eventName === 'delta') {
          if (!active.hasRunRecord || typeof event.runId !== 'string' || event.runId !== active.runId || typeof event.content !== 'string') throw new Error('The agent stream returned an invalid output chunk.');
          const output = streamedOutput.current + event.content;
          const outputBytes = utf8.encode(output).byteLength;
          if (outputBytes > AGENT_RUN_OUTPUT_BYTES) {
            void cancelExecution(active);
            throw new Error('Agent output exceeded the 256 KiB client limit.');
          }
          streamedOutput.current = output;
          setSelectedRun((current) => {
            if (!current || current.id !== event.runId) return current;
            return { ...current, output, outputBytes };
          });
        } else if (eventName === 'usage') {
          if (event.runId !== active.runId) throw new Error('The usage event referenced a different run.');
          const usage = normalizeAgentRunUsage(event.usage);
          if (!usage) throw new Error('The agent stream returned invalid usage data.');
          setSelectedRun((current) => current ? { ...current, usage } : current);
        } else if (eventName === 'error') {
          const message = typeof event.error === 'string' && event.error.length <= 300 ? event.error : 'Agent execution failed.';
          throw new Error(message);
        } else {
          throw new Error(`The agent stream returned an unsupported ${eventName} event.`);
        }
      });

      if (active.runId && isCurrent()) await loadRunDetail(active.agentId, active.runId);
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && isCurrent()) toast.error(error instanceof Error ? error.message : 'Agent execution failed.');
      if (active.runId && scopeRef.current === requestedScope && selectedAgentRef.current === active.agentId) {
        await loadRunDetail(active.agentId, active.runId).catch(() => undefined);
      }
    } finally {
      if (activeExecution.current === active) {
        activeExecution.current = undefined;
        setIsExecuting(false);
      }
      if (scopeRef.current === requestedScope && selectedAgentRef.current === active.agentId) await loadRuns(active.agentId, 1);
    }
  };

  const filteredAgents = agents.filter((agent) => agent.name.toLowerCase().includes(searchQuery.toLowerCase()));
  const currentModel = editingAgent?.aiModel || editingAgent?.model || '';
  const modelOptions = currentModel && !catalog.models.some((model) => model.id === currentModel)
    ? [{ id: currentModel, name: `${currentModel} (current)` }, ...catalog.models]
    : catalog.models;

  return <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-8 p-6 md:p-8">
    <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
      <div><h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-white"><Bot className="h-8 w-8 text-primary" />AI Agents</h1><p className="mt-1 text-gray-400">Create specialized assistants and inspect their durable run history.</p></div>
      <div className="flex w-full items-center gap-3 md:w-auto">
        <div className="relative flex-1 md:w-64"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search agents..." className="w-full rounded-xl border border-white/10 bg-black/40 py-2 pl-9 pr-4 text-sm text-white focus:border-primary/50 focus:outline-none" /></div>
        <button onClick={() => { setEditingAgent({ name: '', description: '', systemPrompt: '', aiModel: catalog.models[0]?.id ?? '', temperature: 0.7, tools: [] }); setIsSlideOverOpen(true); }} disabled={!projectMutationsAllowed || projectLoading} className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-4 w-4" /><span className="hidden sm:inline">Create Agent</span></button>
      </div>
    </div>

    {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
    {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} Project-scoped actions are disabled.</div> : null}
    {projectContext?.status === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE} Agents and run history remain readable.</div> : null}
    {projectContext ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><FolderKanban className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Project agents</p><p className="truncate font-medium text-white">{projectContext.projectName} <span className="text-xs capitalize text-gray-500">({projectContext.status})</span></p></div></div><button onClick={() => navigate('/app/agents', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:text-white"><X className="h-3.5 w-3.5" />Show all agents</button></div> : null}

    <section className="space-y-6">
      <h2 className="text-xl font-semibold text-white">Your Agents</h2>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {!filteredAgents.length ? <div className="col-span-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/5 py-12"><Bot className="mb-4 h-12 w-12 text-gray-500 opacity-50" /><p className="text-gray-400">No agents found matching your criteria.</p></div> : filteredAgents.map((agent) => <motion.article key={agent.id} layout className="glass-card group relative rounded-2xl border border-white/10 bg-white/5 p-6 transition-all hover:border-primary/30">
          <div className="absolute right-4 top-4 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100"><button onClick={() => { setEditingAgent(agent); setIsSlideOverOpen(true); }} disabled={!projectMutationsAllowed} aria-label={`Edit ${agent.name}`} className="rounded border border-white/10 bg-black/40 p-1.5 text-gray-400 hover:text-white disabled:opacity-40"><Edit2 className="h-4 w-4" /></button><button onClick={() => { setAgentToDelete(agent.id); setDeleteConfirmOpen(true); }} disabled={!projectMutationsAllowed} aria-label={`Delete ${agent.name}`} className="rounded border border-white/10 bg-black/40 p-1.5 text-gray-400 hover:text-red-400 disabled:opacity-40"><Trash2 className="h-4 w-4" /></button></div>
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10"><Bot className="h-6 w-6 text-primary" /></div><h3 className="mb-2 text-lg font-semibold text-white">{agent.name}</h3><p className="mb-6 line-clamp-2 text-sm text-gray-400">{agent.description}</p>
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-white/5 bg-black/20 p-2 text-xs text-gray-500"><Settings className="h-4 w-4" /><span>{agent.aiModel || 'Provider default'}</span><span>•</span><span>Temp: {agent.temperature}</span></div>
          <div className={`mb-4 flex items-center gap-2 px-2 text-xs ${agent.toolState === 'legacy-blocked' ? 'text-amber-300' : 'text-gray-500'}`}><Wrench className="h-3.5 w-3.5" />{agent.toolState === 'legacy-blocked' ? 'Legacy tools blocked — edit and save to reset' : 'Tools disabled'}</div>
          <button onClick={() => openExecution(agent)} className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 font-medium text-white transition-all hover:border-primary/30 hover:text-primary"><Play className="h-4 w-4" /><span>{projectMutationsAllowed ? 'Run & History' : 'View Run History'}</span></button>
        </motion.article>)}
      </div>
    </section>

    <section className="mt-8 space-y-6 border-t border-white/10 pt-8"><h2 className="text-xl font-semibold text-white">Starter Templates</h2><div className="grid grid-cols-1 gap-6 md:grid-cols-3">{TEMPLATES.map((template) => <button type="button" key={template.name} disabled={!projectMutationsAllowed} onClick={() => { setEditingAgent({ ...template, tools: [] }); setIsSlideOverOpen(true); }} className="group rounded-2xl border border-white/10 bg-[#0f121d] p-6 text-left transition-all hover:border-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-50"><div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-500/10"><Terminal className="h-5 w-5 text-cyan-400" /></div><h3 className="mb-2 font-medium text-white">{template.name}</h3><p className="text-sm text-gray-500">{template.description}</p></button>)}</div></section>

    <SlideOver isOpen={isSlideOverOpen} onClose={() => setIsSlideOverOpen(false)} title={editingAgent?.id ? 'Edit Agent' : 'Create Agent'}>
      <form onSubmit={handleSaveAgent} className="space-y-6">
        <label className="block space-y-2 text-sm font-medium text-gray-300">Name<input required value={editingAgent?.name || ''} onChange={(event) => setEditingAgent({ ...editingAgent, name: event.target.value })} className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-white focus:border-primary/50 focus:outline-none" /></label>
        <label className="block space-y-2 text-sm font-medium text-gray-300">Description<input value={editingAgent?.description || ''} onChange={(event) => setEditingAgent({ ...editingAgent, description: event.target.value })} className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-white focus:border-primary/50 focus:outline-none" /></label>
        <label className="block space-y-2 text-sm font-medium text-gray-300">System Prompt<textarea required rows={6} value={editingAgent?.systemPrompt || ''} onChange={(event) => setEditingAgent({ ...editingAgent, systemPrompt: event.target.value })} className="w-full resize-none rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm leading-relaxed text-white focus:border-primary/50 focus:outline-none" /></label>
        <div className="grid grid-cols-2 gap-4"><label className="space-y-2 text-sm font-medium text-gray-300">Model<select value={currentModel} onChange={(event) => setEditingAgent({ ...editingAgent, aiModel: event.target.value, model: undefined })} className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-white focus:border-primary/50 focus:outline-none"><option value="">Provider default</option>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><span className="block text-xs font-normal text-gray-500">{catalog.provider} · {catalog.modelScope}</span></label><label className="space-y-2 text-sm font-medium text-gray-300"><span className="flex justify-between"><span>Temperature</span><span className="text-primary">{editingAgent?.temperature ?? 0.7}</span></span><input type="range" min="0" max="2" step="0.1" value={editingAgent?.temperature ?? 0.7} onChange={(event) => setEditingAgent({ ...editingAgent, temperature: Number(event.target.value) })} className="mt-3 h-2 w-full cursor-pointer appearance-none rounded-lg bg-black/40 accent-primary" /></label></div>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-gray-400"><Wrench className="h-4 w-4" />{editingAgent?.toolState === 'legacy-blocked' ? 'Saving will reset the legacy tool configuration. Tools remain disabled.' : 'Tools are disabled for agents in this release.'}</div>
        <button type="submit" disabled={!projectMutationsAllowed} className="w-full rounded-xl bg-primary py-3 font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{editingAgent?.toolState === 'legacy-blocked' ? 'Save & Reset Disabled Tools' : 'Save Agent'}</button>
      </form>
    </SlideOver>

    {isExecuteModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"><motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#09090B] shadow-2xl">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 p-4"><div><h3 className="flex items-center gap-2 font-semibold text-white"><Play className="h-4 w-4 text-green-400" />{executingAgent?.name}</h3><p className="mt-1 text-xs text-gray-500">Durable runs · tools disabled</p></div><button onClick={() => void closeExecution()} aria-label="Close run history" className="text-2xl leading-none text-gray-500 hover:text-white">&times;</button></div>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-h-0 overflow-y-auto p-6">
          <label className="block text-sm font-medium text-gray-400">Prompt<textarea rows={3} maxLength={16_384} value={executePrompt} onChange={(event) => setExecutePrompt(event.target.value)} disabled={!projectMutationsAllowed || isExecuting || executingAgent?.toolState === 'legacy-blocked'} placeholder={!projectMutationsAllowed ? 'Archived projects are read-only.' : executingAgent?.toolState === 'legacy-blocked' ? 'Edit and save this agent to reset its disabled tools.' : 'Enter input for the agent...'} className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-black/40 p-4 text-white focus:border-green-500/50 focus:outline-none disabled:opacity-50" /></label>
          <div className="mt-3 flex justify-end">{isExecuting ? <button onClick={() => void stopExecution()} className="flex items-center gap-2 rounded-xl bg-red-500/20 px-6 py-2.5 font-medium text-red-300 hover:bg-red-500 hover:text-white"><StopCircle className="h-4 w-4" />Cancel run</button> : <button onClick={() => void handleExecute()} disabled={!executePrompt.trim() || !projectMutationsAllowed || executingAgent?.toolState === 'legacy-blocked'} className="flex items-center gap-2 rounded-xl bg-green-500/20 px-6 py-2.5 font-medium text-green-400 hover:bg-green-500 hover:text-white disabled:opacity-50"><Play className="h-4 w-4" />Run Agent</button>}</div>
          {runDetailLoading ? <div className="mt-6 flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Loading run details…</div> : selectedRun ? <div className="mt-6 space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4"><div className="rounded-lg bg-white/5 p-3"><p className="text-xs text-gray-500">Status</p><p className="mt-1 capitalize text-white">{statusLabel(selectedRun.status)}</p></div><div className="rounded-lg bg-white/5 p-3"><p className="text-xs text-gray-500">Provider</p><p className="mt-1 truncate text-white">{selectedRun.provider ?? 'Pending'}</p></div><div className="rounded-lg bg-white/5 p-3"><p className="text-xs text-gray-500">Model</p><p className="mt-1 truncate text-white">{selectedRun.model ?? selectedRun.agent.requestedModel}</p></div><div className="rounded-lg bg-white/5 p-3"><p className="text-xs text-gray-500">Usage</p><p className="mt-1 text-white">{selectedRun.usage?.totalTokens?.toLocaleString() ?? 'Unavailable'} tokens</p><p className="mt-1 text-xs text-gray-500">{selectedRun.usage?.inputTokens?.toLocaleString() ?? '?'} in · {selectedRun.usage?.outputTokens?.toLocaleString() ?? '?'} out{selectedRun.usage?.totalDurationMs !== undefined ? ` · ${selectedRun.usage.totalDurationMs.toLocaleString()} ms` : ''}</p></div></div>
            {selectedRun.error ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{selectedRun.error.message} <span className="text-xs text-red-300">({selectedRun.error.code})</span></div> : null}
            <div className="rounded-xl border border-white/5 bg-black/60 p-5 font-mono text-sm text-gray-300"><p className="mb-3 font-sans text-xs uppercase tracking-wide text-gray-500">Output · {selectedRun.outputBytes.toLocaleString()} bytes{selectedRun.outputTruncated ? ' · truncated' : ''}</p>{isExecuting && !selectedRun.output ? <span className="flex items-center gap-2 text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Waiting for output…</span> : <pre className="whitespace-pre-wrap break-words font-inherit">{selectedRun.output || 'No output was recorded.'}</pre>}</div>
            <div><h4 className="mb-3 text-sm font-medium text-gray-300">Timeline</h4><ol className="space-y-2">{selectedRun.timeline.map((event) => <li key={`${event.sequence}-${event.type}`} className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.03] p-3 text-sm"><Clock3 className="mt-0.5 h-4 w-4 text-primary" /><div><p className="capitalize text-gray-200">{statusLabel(event.type)}</p><p className="mt-1 text-xs text-gray-500">{dateTime(event.timestamp)}{event.provider ? ` · ${event.provider}` : ''}{event.model ? ` · ${event.model}` : ''}{event.code ? ` · ${event.code}` : ''}</p></div></li>)}</ol></div>
          </div> : <p className="mt-8 rounded-xl border border-dashed border-white/10 p-6 text-center text-sm text-gray-500">Select a recent run to inspect its output and timeline.</p>}
        </div>
        <aside className="min-h-0 overflow-y-auto border-t border-white/10 bg-white/[0.02] p-4 md:border-l md:border-t-0">
          <div className="mb-3"><div className="flex items-center justify-between gap-2"><h4 className="text-sm font-semibold text-white">Recent runs</h4><span className="text-xs text-gray-500">{runPagination.total} for this agent</span></div><p className="mt-1 text-xs text-gray-600">Owner retention cap: {AGENT_RUN_OWNER_RETENTION}. Delete terminal runs to reclaim capacity.</p></div>
          {runsLoading ? <div className="flex items-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div> : !recentRuns.length ? <p className="text-sm text-gray-500">No runs recorded on this page.</p> : <div className="space-y-2">{recentRuns.map((run) => <div key={run.id} className={`flex items-start rounded-xl border transition-colors ${selectedRun?.id === run.id ? 'border-primary/40 bg-primary/10' : 'border-white/5 bg-black/20 hover:border-white/20'}`}><button onClick={() => void loadRunDetail(run.agentId, run.id)} className="min-w-0 flex-1 p-3 text-left"><div className="flex items-center justify-between gap-2"><span className="truncate text-xs text-gray-500">{run.id}</span><span className={`text-xs capitalize ${activeStatus(run.status) ? 'text-cyan-300' : run.status === 'succeeded' ? 'text-emerald-300' : 'text-amber-300'}`}>{statusLabel(run.status)}</span></div><p className="mt-2 text-xs text-gray-400">{dateTime(run.createdAt ?? run.queuedAt)}</p><p className="mt-1 truncate text-xs text-gray-500">{run.provider ?? 'Provider pending'} · {run.model ?? run.agent.requestedModel}</p></button>{projectMutationsAllowed && isTerminalAgentRun(run) ? <button onClick={() => setRunToDelete(run)} aria-label={`Delete run ${run.id}`} className="m-2 rounded-lg p-1.5 text-gray-600 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button> : null}</div>)}</div>}
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-white/10 pt-3"><button onClick={() => { if (executingAgent) void loadRuns(executingAgent.id, runPagination.page - 1); }} disabled={runsLoading || runPagination.page <= 1 || !executingAgent} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-300 disabled:opacity-40">Previous</button><span className="text-xs text-gray-500">Page {runPagination.page} of {runPagination.totalPages}</span><button onClick={() => { if (executingAgent) void loadRuns(executingAgent.id, runPagination.page + 1); }} disabled={runsLoading || runPagination.page >= runPagination.totalPages || !executingAgent} className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-gray-300 disabled:opacity-40">Next</button></div>
        </aside>
      </div>
    </motion.div></div> : null}

    <ConfirmDialog isOpen={deleteConfirmOpen} title="Delete Agent" message="Delete this agent? Agents with run history must be retained by the backend." confirmText="Delete" isDestructive onConfirm={() => void confirmDelete()} onCancel={() => { setDeleteConfirmOpen(false); setAgentToDelete(null); }} />
    <ConfirmDialog isOpen={Boolean(runToDelete)} title="Delete Agent Run" message="Delete this terminal run and its stored prompt, output, usage, and timeline? This reclaims one retained-run slot and cannot be undone." confirmText={runDeleting ? 'Deleting…' : 'Delete Run'} isDestructive onConfirm={() => void confirmRunDelete()} onCancel={() => { if (!runDeleting) setRunToDelete(undefined); }} />
  </motion.div>;
}
