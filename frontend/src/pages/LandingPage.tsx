import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Code2,
  Database,
  FolderKanban,
  GitBranch,
  Gauge,
  MessageSquare,
  Settings2,
  ShieldCheck,
} from 'lucide-react';

const currentFeatures = [
  {
    icon: MessageSquare,
    title: 'AI Chat',
    detail: 'Provider-neutral streaming chat with explicit provider/model selection and no silent fallback.',
  },
  {
    icon: FolderKanban,
    title: 'Project Rooms',
    detail: 'Owner-scoped projects, tags, activity, archive/restore, and guarded project context.',
  },
  {
    icon: Code2,
    title: 'Code Lab',
    detail: 'An opt-in Python and JavaScript playground backed by disposable, resource-limited containers.',
  },
  {
    icon: Settings2,
    title: 'Runtime Settings',
    detail: 'Local, hybrid, and remote topology reporting with dependency-specific connection checks.',
  },
  {
    icon: Bot,
    title: 'Models and Agents',
    detail: 'Model management, smart routing, GPU status, and provider-backed agent execution.',
  },
  {
    icon: Database,
    title: 'Document Storage',
    detail: 'Validated owner/project-scoped uploads plus browser-local PDF merge, extract, and rotate utilities.',
  },
  {
    icon: Database,
    title: 'Dataset Lab',
    detail: 'Bounded CSV/JSON upload, deterministic quality profiling, preview, download, and immutable cleaned derivations.',
  },
  {
    icon: BookOpen,
    title: 'Knowledge / RAG',
    detail: 'Bounded TXT/Markdown ingestion and owner/project-scoped retrieval through an explicit embedding profile.',
  },
  {
    icon: GitBranch,
    title: 'Repository Analyzer',
    detail: 'Read-only, bounded ZIP inventory with evidence for languages, manifests, frameworks, tests, and infrastructure signals.',
  },
  {
    icon: GitBranch,
    title: 'Experimental Workflows',
    detail: 'A server-validated Input → Prompt → LLM → Output slice with persistent definitions, runs, cancellation, and history.',
  },
  {
    icon: BookOpen,
    title: 'Notebook Mode',
    detail: 'Owner/project-scoped Python and Markdown editing with opt-in isolated execution, cancellation, durable history, and verified output.',
  },
  {
    icon: Gauge,
    title: 'Model Benchmarks',
    detail: 'Bounded six-call chat-suite runs with measured latency, output size, optional provider usage, safe GPU snapshots, comparison, and export.',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-[#070910] text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#070910]/90 backdrop-blur-xl">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4" aria-label="Main navigation">
          <Link to="/" className="flex items-center gap-3 font-semibold tracking-tight">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/20 text-primary"><Bot className="h-5 w-5" /></span>
            KFive AI
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/login" className="rounded-lg px-3 py-2 text-sm text-gray-300 hover:bg-white/5 hover:text-white">Sign in</Link>
            <Link to="/register" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90">Create account</Link>
          </div>
        </nav>
      </header>

      <main>
        <section className="relative overflow-hidden border-b border-white/10">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(139,92,246,0.18),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(6,182,212,0.12),transparent_40%)]" />
          <div className="relative mx-auto grid max-w-7xl gap-12 px-5 py-20 lg:grid-cols-[minmax(0,1fr)_420px] lg:py-28">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200">
                Experimental platform — active development
              </div>
              <h1 className="mt-6 max-w-4xl text-5xl font-bold tracking-tight sm:text-6xl">
                A local-first AI engineering workspace, built in verified slices.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-gray-300">
                KFive brings provider-neutral AI chat, persistent projects, model controls, agents, documents, and an isolated online compiler into one browser workspace. Features are labeled honestly while their external-service paths are tested.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link to="/register" className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 font-medium text-white hover:bg-primary/90">
                  Open KFive <ArrowRight className="h-4 w-4" />
                </Link>
                <a href="#current-features" className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 font-medium text-gray-200 hover:bg-white/10">
                  See current features
                </a>
              </div>
            </div>

            <aside className="h-fit rounded-3xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-xl">
              <div className="flex items-center gap-3"><ShieldCheck className="h-6 w-6 text-emerald-400" /><h2 className="text-lg font-semibold">Designed around explicit boundaries</h2></div>
              <ul className="mt-5 space-y-4 text-sm leading-6 text-gray-300">
                <li>Service and provider locations come from validated configuration.</li>
                <li>AI providers never fall back silently.</li>
                <li>Project resources are owner-scoped and archived projects become read-only.</li>
                <li>Code Lab is disabled by default and never executes code in the browser or backend process.</li>
                <li>Planned modules are not presented as completed features.</li>
              </ul>
            </aside>
          </div>
        </section>

        <section id="current-features" className="mx-auto max-w-7xl px-5 py-20">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">Current source slices</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">Available for evaluation, with live E2E work still in progress</h2>
            <p className="mt-4 text-gray-400">These areas build and have automated coverage. They remain Experimental until their critical target-host path has been executed.</p>
          </div>
          <div className="mt-10 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {currentFeatures.map(({ icon: Icon, title, detail }) => (
              <article key={title} className="rounded-2xl border border-white/10 bg-white/[0.035] p-6">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary"><Icon className="h-5 w-5" /></span>
                  <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-200">Experimental</span>
                </div>
                <h3 className="mt-5 text-xl font-semibold">{title}</h3>
                <p className="mt-3 text-sm leading-6 text-gray-400">{detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border-y border-white/10 bg-white/[0.025]">
          <div className="mx-auto max-w-7xl px-5 py-16">
            <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
              <div><p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-300">Planned roadmap</p><h2 className="mt-3 text-3xl font-bold">The larger platform is not being faked ahead of implementation.</h2></div>
              <p className="leading-7 text-gray-400">The isolated Document Processor and remaining PDF utilities, OCR, deeper repository intelligence, broader workflow automation, ML experiments, Kubernetes, GitOps, observability, and remote production deployment remain planned or require their own tested vertical slices.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-8 text-sm text-gray-500 sm:flex-row sm:items-center sm:justify-between">
        <p>KFive AI — local-first, deployable, and under active verification.</p>
        <Link to="/login" className="text-gray-300 hover:text-white">Sign in to the workspace</Link>
      </footer>
    </div>
  );
}
