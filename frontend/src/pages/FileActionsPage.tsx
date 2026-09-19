import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle, Combine, Download,
  File as FileIcon, FolderOpen, Loader2, RotateCw, Scissors, Trash2, UploadCloud,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import {
  MAX_PDF_PAGE_SELECTION_CHARS, deletePdfPages, extractPdfPages, mergePdfs, pdfOutputFilename,
  publicPdfToolError, readBrowserPdfInputs, rotatePdfPages, reorderPdfPages, duplicatePdfPages,
} from '@/services/pdfTools';

type ToolId = 'merge' | 'extract' | 'rotate' | 'delete' | 'reorder' | 'duplicate';
type RotationAngle = 90 | 180 | 270;

interface Tool {
  id: ToolId;
  name: string;
  description: string;
  icon: typeof Combine;
  multiple: boolean;
}

interface PdfResult {
  filename: string;
  pageCount: number;
  url: string;
}

const TOOLS: Tool[] = [
  { id: 'merge', name: 'Merge PDF', description: 'Combine 2–10 PDFs in the order you choose.', icon: Combine, multiple: true },
  { id: 'extract', name: 'Extract Pages', description: 'Create a new PDF from selected pages of one PDF.', icon: Scissors, multiple: false },
  { id: 'rotate', name: 'Rotate Pages', description: 'Rotate selected pages by 90, 180, or 270 degrees.', icon: RotateCw, multiple: false },
  { id: 'delete', name: 'Delete Pages', description: 'Remove selected pages in a new PDF, keeping the original unchanged.', icon: Trash2, multiple: false },
  { id: 'reorder', name: 'Reorder Pages', description: 'List every page exactly once in a new order. The original stays unchanged.', icon: ArrowUp, multiple: false },
  { id: 'duplicate', name: 'Duplicate Pages', description: 'Add one copy immediately after each selected page in a new PDF.', icon: Combine, multiple: false },
];

export default function FileActionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTool = searchParams.get('tool');
  const [activeTool, setActiveTool] = useState<Tool>();
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [pageSelection, setPageSelection] = useState('all');
  const [rotationAngle, setRotationAngle] = useState<RotationAngle>(90);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<PdfResult>();
  const resultUrlRef = useRef<string>();
  const operationIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearResult = () => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = undefined;
    setResult(undefined);
  };

  const resetState = () => {
    operationIdRef.current += 1;
    clearResult();
    setFiles([]);
    setIsDragging(false);
    setProcessing(false);
    setPageSelection(requestedTool === 'delete' ? '' : 'all');
    setRotationAngle(90);
    setError(undefined);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  useEffect(() => {
    const tool = TOOLS.find((candidate) => candidate.id === requestedTool);
    setActiveTool(tool);
    resetState();
  }, [requestedTool]);

  useEffect(() => () => {
    operationIdRef.current += 1;
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
  }, []);

  const leaveTool = () => {
    resetState();
    setSearchParams({});
  };

  const addFiles = (incoming: File[]) => {
    if (!activeTool || incoming.length === 0) return;
    clearResult();
    setError(undefined);
    if (!activeTool.multiple) {
      setFiles([incoming[0]]);
      return;
    }
    setFiles((current) => {
      const combined = [...current, ...incoming];
      if (combined.length > 10) setError('Merge PDF accepts at most 10 files. Extra files were not added.');
      return combined.slice(0, 10);
    });
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files || []));
    event.target.value = '';
  };

  const removeFile = (index: number) => {
    clearResult();
    setError(undefined);
    setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
  };

  const moveFile = (index: number, offset: -1 | 1) => {
    setFiles((current) => {
      const destination = index + offset;
      if (destination < 0 || destination >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
      return reordered;
    });
  };

  const processFiles = async () => {
    if (!activeTool || processing) return;
    if (activeTool.id === 'merge' && (files.length < 2 || files.length > 10)) {
      setError('Select between 2 and 10 PDF files to merge.');
      return;
    }
    if (activeTool.id !== 'merge' && files.length !== 1) {
      setError('Select one PDF to process.');
      return;
    }
    if (activeTool.id !== 'merge' && !pageSelection.trim()) {
      setError('Enter a page selection such as 1-3,5 or all.');
      return;
    }

    clearResult();
    setError(undefined);
    setProcessing(true);
    const operationId = operationIdRef.current + 1;
    operationIdRef.current = operationId;
    try {
      const inputs = await readBrowserPdfInputs(files, activeTool.id === 'merge' ? 'merge' : 'single');
      const output = activeTool.id === 'merge'
        ? await mergePdfs(inputs)
        : activeTool.id === 'extract'
          ? await extractPdfPages(inputs[0], pageSelection)
          : activeTool.id === 'delete'
            ? await deletePdfPages(inputs[0], pageSelection)
            : activeTool.id === 'reorder'
              ? await reorderPdfPages(inputs[0], pageSelection)
              : activeTool.id === 'duplicate'
                ? await duplicatePdfPages(inputs[0], pageSelection)
                : await rotatePdfPages(inputs[0], pageSelection, rotationAngle);
      if (operationIdRef.current !== operationId) return;
      const bytes = new Uint8Array(output.bytes);
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: 'application/pdf' }));
      resultUrlRef.current = url;
      setResult({ filename: pdfOutputFilename(activeTool.id, files[0]?.name), pageCount: output.pageCount, url });
    } catch (processingError) {
      if (operationIdRef.current !== operationId) return;
      setError(publicPdfToolError(processingError));
    } finally {
      if (operationIdRef.current === operationId) setProcessing(false);
    }
  };

  const canProcess = activeTool?.id === 'merge'
    ? files.length >= 2 && files.length <= 10
    : files.length === 1 && Boolean(pageSelection.trim())
      && pageSelection.length <= MAX_PDF_PAGE_SELECTION_CHARS;

  return (
    <div className="flex h-full flex-col overflow-hidden p-6 md:p-8">
      <AnimatePresence mode="wait">
        {!activeTool ? (
          <motion.div key="tools" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-auto w-full max-w-6xl flex-1 space-y-8 overflow-y-auto pb-10">
            <header>
              <h1 className="flex items-center gap-3 text-3xl font-bold text-white"><FolderOpen className="h-8 w-8 text-primary" />PDF Utilities</h1>
              <p className="mt-2 text-gray-400">These operations run locally in this browser. Inputs are not uploaded, and results are downloads—not saved to Documents or Projects.</p>
              <p className="mt-2 max-w-3xl text-sm text-amber-300">Structural PDF changes do not sanitize links, actions, attachments, or other active content. Treat every generated PDF as untrusted.</p>
            </header>
            <div className="grid gap-5 md:grid-cols-3">
              {TOOLS.map((tool) => (
                <button key={tool.id} onClick={() => setSearchParams({ tool: tool.id })} className="group relative rounded-2xl border border-white/10 bg-white/5 p-6 text-left transition hover:-translate-y-1 hover:border-primary/50">
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl border border-white/5 bg-black/20"><tool.icon className="h-6 w-6 text-primary" /></div>
                  <h2 className="text-lg font-semibold text-white">{tool.name}</h2>
                  <p className="mt-2 text-sm leading-6 text-gray-400">{tool.description}</p>
                  <ArrowRight className="absolute right-5 top-5 h-4 w-4 text-gray-600 transition group-hover:text-primary" />
                </button>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div key={activeTool.id} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto">
            <button onClick={leaveTool} className="mb-6 inline-flex w-fit items-center gap-2 text-sm text-gray-400 hover:text-white"><ArrowLeft className="h-4 w-4" />Back to PDF Utilities</button>
            <section className="flex-1 rounded-2xl border border-white/10 bg-white/5 p-6 md:p-8">
              <header className="flex items-start gap-4 border-b border-white/10 pb-6">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10"><activeTool.icon className="h-7 w-7 text-primary" /></div>
                <div><h1 className="text-2xl font-bold text-white">{activeTool.name}</h1><p className="mt-1 text-gray-400">{activeTool.description}</p><p className="mt-2 text-xs text-gray-500">Processed locally. The output is not added to your KFive document library.</p></div>
              </header>

              <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" multiple={activeTool.multiple} onChange={handleFileChange} className="hidden" />

              {!result && !processing ? (
                <div className="mt-6 space-y-6">
                  <div onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }} onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }} onDrop={(event) => { event.preventDefault(); setIsDragging(false); addFiles(Array.from(event.dataTransfer.files)); }} className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${isDragging ? 'border-primary bg-primary/5' : 'border-white/10 bg-black/20'}`}>
                    <UploadCloud className="mx-auto h-12 w-12 text-gray-500" />
                    <p className="mt-3 font-medium text-white">Drop {activeTool.multiple ? 'PDF files' : 'a PDF file'} here</p>
                    <p className="mt-1 text-sm text-gray-500">or choose files from this device</p>
                    <button onClick={() => fileInputRef.current?.click()} className="mt-4 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-gray-200 hover:border-primary/40">Choose PDF{activeTool.multiple ? 's' : ''}</button>
                  </div>

                  {files.length ? (
                    <div className="space-y-3">
                      <div className="flex items-center justify-between"><h2 className="font-semibold text-white">Selected files ({files.length}{activeTool.multiple ? '/10' : ''})</h2>{activeTool.multiple && files.length < 10 ? <button onClick={() => fileInputRef.current?.click()} className="text-sm text-primary hover:text-white">Add PDFs</button> : null}</div>
                      {files.map((file, index) => (
                        <div key={`${file.name}-${file.lastModified}-${index}`} className="flex items-center gap-3 rounded-xl border border-white/10 bg-black/20 p-3">
                          <FileIcon className="h-5 w-5 shrink-0 text-gray-500" />
                          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-white">{file.name}</p><p className="text-xs text-gray-500">{(file.size / 1024 / 1024).toFixed(2)} MB</p></div>
                          {activeTool.multiple ? <div className="flex gap-1"><button onClick={() => moveFile(index, -1)} disabled={index === 0} aria-label={`Move ${file.name} up`} className="rounded p-1.5 text-gray-400 hover:bg-white/5 hover:text-white disabled:opacity-25"><ArrowUp className="h-4 w-4" /></button><button onClick={() => moveFile(index, 1)} disabled={index === files.length - 1} aria-label={`Move ${file.name} down`} className="rounded p-1.5 text-gray-400 hover:bg-white/5 hover:text-white disabled:opacity-25"><ArrowDown className="h-4 w-4" /></button></div> : null}
                          <button onClick={() => removeFile(index)} aria-label={`Remove ${file.name}`} className="rounded p-1.5 text-gray-500 hover:bg-red-500/10 hover:text-red-300"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {activeTool.id !== 'merge' && files.length === 1 ? (
                    <div className="grid gap-4 rounded-xl border border-white/10 bg-black/20 p-4 sm:grid-cols-2">
                      <label className="text-sm font-medium text-gray-300">{activeTool.id === 'delete' ? 'Pages to remove' : 'Pages'}<input maxLength={MAX_PDF_PAGE_SELECTION_CHARS} value={pageSelection} onChange={(event) => { setPageSelection(event.target.value); setError(undefined); }} placeholder={activeTool.id === 'delete' ? '1-3,5' : 'all or 1-3,5'} className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white outline-none focus:border-primary/50" /><span className="mt-1 block text-xs font-normal text-gray-500">{activeTool.id === 'delete' ? 'Keep at least one page. Use a list such as 1-3,5 (maximum 4096 characters).' : 'Use all or a list such as 1-3,5 (maximum 4096 characters).'}</span></label>
                      {activeTool.id === 'rotate' ? <label className="text-sm font-medium text-gray-300">Rotation<select value={rotationAngle} onChange={(event) => setRotationAngle(Number(event.target.value) as RotationAngle)} className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-white outline-none focus:border-primary/50"><option value={90}>90° clockwise</option><option value={180}>180°</option><option value={270}>270° clockwise</option></select></label> : <div className="text-sm text-gray-500 sm:pt-7">{activeTool.id === 'delete' ? 'Remaining pages keep their original order in a new PDF. The original is unchanged. This is not secure redaction or sanitization.' : 'The selected pages are copied into one new PDF in the specified order.'}</div>}
                    </div>
                  ) : null}

                  {activeTool.id === 'reorder' ? <p className="text-sm text-gray-400">Include every page exactly once, for example 3,1-2 for a three-page PDF. Use all to keep the original order. Duplicate or missing pages are rejected. Drag reordering and thumbnails are not available yet.</p> : null}
                  {activeTool.id === 'duplicate' ? <p className="text-sm text-gray-400">Each selected page gets one extra copy immediately after it. Repeating a page number does not add more copies. Original page order is preserved; all doubles the page count. Output is limited to 500 pages.</p> : null}
                  {error ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{error}</div> : null}
                  <div className="flex justify-end gap-3 border-t border-white/10 pt-5"><button onClick={resetState} disabled={!files.length} className="rounded-xl border border-white/10 px-5 py-2.5 text-sm font-medium text-gray-300 disabled:opacity-40">Reset</button><button onClick={() => void processFiles()} disabled={!canProcess} className="rounded-xl bg-primary px-6 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">{activeTool.name}</button></div>
                </div>
              ) : null}

              {processing ? <div className="flex min-h-80 flex-col items-center justify-center text-center"><Loader2 className="h-12 w-12 animate-spin text-primary" /><h2 className="mt-5 text-xl font-semibold text-white">Processing locally…</h2><p className="mt-2 max-w-md text-sm text-gray-400">Keep this tab open while the browser reads and writes the PDF. No percentage is available.</p></div> : null}
              {result ? <div className="flex min-h-80 flex-col items-center justify-center text-center"><div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10"><CheckCircle className="h-8 w-8 text-emerald-400" /></div><h2 className="mt-5 text-2xl font-bold text-white">PDF ready</h2><p className="mt-2 text-gray-400">The result contains {result.pageCount} {result.pageCount === 1 ? 'page' : 'pages'} and has not been saved to Documents or Projects.</p><p className="mt-2 max-w-lg text-sm text-amber-300">This structural operation is not sanitization. Keep treating the downloaded PDF as untrusted.</p><div className="mt-7 flex flex-wrap justify-center gap-3"><a href={result.url} download={result.filename} className="inline-flex items-center gap-2 rounded-xl bg-primary px-6 py-3 font-medium text-white"><Download className="h-5 w-5" />Download {result.filename}</a><button onClick={resetState} className="rounded-xl border border-white/10 px-6 py-3 font-medium text-gray-300 hover:text-white">Start over</button></div></div> : null}
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
