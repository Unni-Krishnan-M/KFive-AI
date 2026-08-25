import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { 
  Upload, Search, File as FileIcon, UploadCloud, CheckCircle, Database, FolderKanban, FolderOpen, X
} from 'lucide-react';
import { documentApi } from '@/services/api';
import toast from 'react-hot-toast';
import { SlideOver } from '@/components/ui/SlideOver';
import { useNavigate } from 'react-router-dom';
import { PROJECT_ARCHIVED_MESSAGE } from '@/services/projectContext';
import { useProjectContext } from '@/hooks/useProjectContext';
import { readableApiError } from '@/services/runtimeSettings';

interface Document {
  _id: string;
  originalName: string;
  size: number;
  mimeType: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  errorMessage?: string;
  createdAt: string;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [isSlideOverOpen, setIsSlideOverOpen] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { requested: projectRequested, context: projectContext, loading: projectLoading, error: projectError } = useProjectContext();
  const projectId = projectContext?.projectId;
  const projectScopeReady = !projectRequested || Boolean(projectContext);
  const uploadAllowed = projectScopeReady && projectContext?.status !== 'archived';

  useEffect(() => {
    if (!projectScopeReady) {
      setDocuments([]);
      return;
    }
    fetchDocuments();
  }, [projectId, projectScopeReady]);

  const fetchDocuments = async () => {
    try {
      const res = await documentApi.getDocuments(projectId);
      if (res.data.success) {
        setDocuments(res.data.data);
      }
    } catch (error) {
      toast.error(readableApiError(error, 'Failed to fetch documents.'));
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!uploadAllowed) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFileUpload(e.dataTransfer.files[0]);
    }
  };

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await handleFileUpload(e.target.files[0]);
    }
  };

  const handleFileUpload = async (file: File) => {
    if (!uploadAllowed) {
      toast.error(projectError || PROJECT_ARCHIVED_MESSAGE);
      return;
    }
    const formData = new FormData();
    formData.append('document', file);
    
    setIsUploading(true);

    try {
      await documentApi.uploadDocument(formData, projectId);
      toast.success(projectContext ? `Document added to ${projectContext.projectName}` : 'Document uploaded successfully');
      await fetchDocuments();
    } catch (error) {
      toast.error(readableApiError(error, 'Failed to upload document.'));
    } finally {
      setIsUploading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };
  
  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return { color: 'text-red-500', bg: 'bg-red-500/10' };
    if (['doc', 'docx'].includes(ext || '')) return { color: 'text-blue-500', bg: 'bg-blue-500/10' };
    if (['csv', 'xlsx'].includes(ext || '')) return { color: 'text-green-500', bg: 'bg-green-500/10' };
    return { color: 'text-gray-400', bg: 'bg-gray-500/10' };
  };

  const filteredDocs = documents.filter(d => d.originalName.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 md:p-8 space-y-8"
    >
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
            <Database className="w-8 h-8 text-cyan-400" />
            Documents
          </h1>
          <p className="text-gray-400 mt-1">Upload documents and track their actual processing status.</p>
        </div>
        <button onClick={() => navigate('/app/files')} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-gray-200 hover:border-primary/40 hover:text-white">
          <FolderOpen className="h-4 w-4 text-primary" />
          Open PDF Utilities
        </button>
      </div>

      <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-gray-400">PDF Utilities run locally in your browser. Select the source files again there; stored Documents are not passed to the utility or overwritten.</p>

      {projectLoading ? <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-gray-400">Verifying project context…</div> : null}
      {projectError ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">{projectError} Project-scoped actions are disabled.</div> : null}
      {projectContext?.status === 'archived' ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">{PROJECT_ARCHIVED_MESSAGE}</div> : null}
      {projectContext ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"><div className="flex min-w-0 items-center gap-3"><FolderKanban className="h-5 w-5 shrink-0 text-primary" /><div className="min-w-0"><p className="text-xs uppercase tracking-wide text-gray-500">Project documents</p><p className="truncate font-medium text-white">{projectContext.projectName} <span className="text-xs capitalize text-gray-500">({projectContext.status})</span></p></div></div><button onClick={() => navigate('/app/documents', { replace: true, state: null })} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-gray-300 hover:text-white"><X className="h-3.5 w-3.5" />Show all documents</button></div> : null}

      {/* Upload Zone */}
      <div 
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        className={`relative w-full rounded-2xl border-2 border-dashed flex flex-col items-center justify-center p-12 transition-all overflow-hidden ${
          isDragging 
            ? 'border-cyan-500 bg-cyan-500/5' 
            : 'border-white/10 hover:border-white/20 bg-black/20 hover:bg-black/40'
        }`}
      >
        <div className={`absolute inset-0 bg-gradient-to-t from-cyan-500/10 to-transparent flex items-end opacity-0 transition-opacity ${isDragging && 'opacity-100 pointer-events-none'}`}></div>
        
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileInput} 
          disabled={!uploadAllowed || isUploading}
          className="hidden" 
          accept=".pdf,.doc,.docx,.txt,.csv"
        />
        
        {isUploading ? (
          <div className="flex flex-col items-center z-10 w-full max-w-sm">
            <UploadCloud className="w-12 h-12 text-cyan-400 mb-4 animate-bounce" />
            <p className="text-white font-medium mb-2">Uploading file…</p>
            <p className="text-xs text-center text-gray-500">Waiting for the upload request to finish. Processing status will appear in the document list.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center z-10 text-center">
            <div className={`w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mb-4 group ${uploadAllowed ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`} onClick={() => uploadAllowed && fileInputRef.current?.click()}>
              <Upload className="w-8 h-8 text-cyan-400 group-hover:scale-110 transition-transform" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">Drag & Drop files here</h3>
            <p className="text-sm text-gray-400 mb-6 max-w-md">
              Store supported PDFs, Word documents, CSVs, or text files. Maximum 50 MB per file.
            </p>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={!uploadAllowed}
              className="px-6 py-2.5 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors border border-white/5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Browse Files
            </button>
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between items-center gap-4 bg-white/5 p-2 rounded-xl border border-white/10">
        <div className="relative w-full sm:w-96 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input 
            type="text"
            placeholder="Search documents by name..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full bg-transparent border-0 pl-10 pr-4 py-2 text-sm text-white focus:outline-none focus:ring-0 placeholder-gray-500"
          />
        </div>
        
      </div>

      {/* Document Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {filteredDocs.length === 0 ? (
          <div className="col-span-full py-12 text-center text-gray-500">
            No documents found.
          </div>
        ) : (
          filteredDocs.map((doc) => {
            const iconStyle = getFileIcon(doc.originalName);
            return (
              <motion.div
                key={doc._id}
                layout
                onClick={() => {
                  setPreviewDoc(doc);
                  setIsSlideOverOpen(true);
                }}
                className="bg-black/20 border border-white/10 p-5 rounded-2xl cursor-pointer hover:bg-black/40 hover:border-white/20 transition-all group relative"
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${iconStyle.bg}`}>
                  <FileIcon className={`w-6 h-6 ${iconStyle.color}`} />
                </div>
                
                <h3 className="text-white font-medium text-sm truncate mb-1 pr-6" title={doc.originalName}>
                  {doc.originalName}
                </h3>
                
                <div className="flex items-center justify-between text-xs text-gray-500 mt-4">
                  <span>{formatSize(doc.size)}</span>
                  {doc.status === 'completed' ? (
                    <span className="flex items-center gap-1 text-green-500 bg-green-500/10 px-2 py-0.5 rounded">
                      <CheckCircle size={12} /> Ready
                    </span>
                  ) : doc.status === 'failed' ? (
                    <span title={doc.errorMessage} className="flex items-center gap-1 text-red-500 bg-red-500/10 px-2 py-0.5 rounded">
                      Failed
                    </span>
                  ) : doc.status === 'pending' ? (
                    <span className="flex items-center gap-1 text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                      Pending
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded animate-pulse">
                      Processing…
                    </span>
                  )}
                </div>
                {doc.status === 'failed' && doc.errorMessage ? <p role="alert" className="mt-3 text-xs text-red-300">{doc.errorMessage}</p> : null}
              </motion.div>
            );
          })
        )}
      </div>

      {/* SlideOver for Document Preview */}
      <SlideOver
        isOpen={isSlideOverOpen}
        onClose={() => setIsSlideOverOpen(false)}
        title="Document Details"
      >
        {previewDoc && (
          <div className="flex flex-col h-full space-y-6">
            <div className="flex flex-col items-center justify-center text-center p-8 bg-black/20 border border-white/5 rounded-2xl mt-2">
               <div className={`w-20 h-20 rounded-2xl flex items-center justify-center mb-4 ${getFileIcon(previewDoc.originalName).bg}`}>
                  <FileIcon className={`w-10 h-10 ${getFileIcon(previewDoc.originalName).color}`} />
                </div>
                <h3 className="text-lg font-semibold text-white break-all leading-tight mb-2">
                  {previewDoc.originalName}
                </h3>
                <p className="text-sm text-gray-400">{formatSize(previewDoc.size)} • {previewDoc.mimeType}</p>
            </div>
            
            <div className="space-y-4 flex-1">
              <div className="bg-white/5 p-4 rounded-xl border border-white/10 border-l-4 border-l-primary/50">
                <p className="text-sm text-gray-400 mb-1">Upload Date</p>
                <p className="text-white font-medium">
                  {new Date(previewDoc.createdAt).toLocaleDateString()} at {new Date(previewDoc.createdAt).toLocaleTimeString()}
                </p>
              </div>
              
              <div className="bg-white/5 p-4 rounded-xl border border-white/10">
                <p className="text-sm text-gray-400 mb-1">Processing status</p>
                <div className="flex items-center gap-2 mt-1">
                  <div className={`w-2 h-2 rounded-full ${previewDoc.status === 'completed' ? 'bg-green-500' : previewDoc.status === 'failed' ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'}`}></div>
                  <p className="text-white font-medium capitalize flex-1">{previewDoc.status}</p>
                </div>
                {previewDoc.status === 'failed' && previewDoc.errorMessage ? <p role="alert" className="mt-2 text-sm text-red-300">{previewDoc.errorMessage}</p> : null}
              </div>
            </div>
            
          </div>
        )}
      </SlideOver>

    </motion.div>
  );
}
