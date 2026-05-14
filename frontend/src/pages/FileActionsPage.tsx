import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FolderOpen, FileText, FileSpreadsheet, Presentation, 
  Image as ImageIcon, Combine, RotateCw, ArrowRight, 
  UploadCloud, ArrowLeft, Loader2, Download, CheckCircle, File as FileIcon
} from 'lucide-react';
import toast from 'react-hot-toast';
import { PDFDocument, degrees } from 'pdf-lib';
import { getToken } from '@/utils/getToken';

type ToolId = 'merge' | 'pdf-word' | 'pdf-excel' | 'pdf-ppt' | 'ppt-pdf' | 'word-pdf' | 'excel-pdf' | 'jpg-pdf' | 'pdf-jpg' | 'rotate';

interface Tool {
  id: ToolId;
  name: string;
  description: string;
  icon: React.ElementType;
  color: string;
  multiple: boolean;
  acceptedTypes: string;
}

const TOOLS: Tool[] = [
  { id: 'merge', name: 'Merge PDF', description: 'Combine multiple PDFs into one unified document.', icon: Combine, color: 'text-purple-400', multiple: true, acceptedTypes: '.pdf' },
  { id: 'pdf-word', name: 'PDF to Word', description: 'Convert your PDF to an editable Word document.', icon: FileText, color: 'text-blue-400', multiple: false, acceptedTypes: '.pdf' },
  { id: 'pdf-excel', name: 'PDF to Excel', description: 'Extract tables from PDF to Excel spreadsheets.', icon: FileSpreadsheet, color: 'text-green-400', multiple: false, acceptedTypes: '.pdf' },
  { id: 'pdf-ppt', name: 'PDF to PowerPoint', description: 'Turn your PDF files into easy to edit PPT presentations.', icon: Presentation, color: 'text-orange-400', multiple: false, acceptedTypes: '.pdf' },
  { id: 'ppt-pdf', name: 'PowerPoint to PDF', description: 'Make PPT and PPTX slideshows easy to view by converting to PDF.', icon: Presentation, color: 'text-red-400', multiple: false, acceptedTypes: '.ppt,.pptx' },
  { id: 'word-pdf', name: 'Word to PDF', description: 'Make DOC and DOCX files easy to read by converting to PDF.', icon: FileText, color: 'text-red-400', multiple: false, acceptedTypes: '.doc,.docx' },
  { id: 'excel-pdf', name: 'Excel to PDF', description: 'Make EXCEL spreadsheets easy to read by converting to PDF.', icon: FileSpreadsheet, color: 'text-red-400', multiple: false, acceptedTypes: '.xls,.xlsx,.csv' },
  { id: 'jpg-pdf', name: 'JPG to PDF', description: 'Convert JPG images to PDF in seconds.', icon: ImageIcon, color: 'text-cyan-400', multiple: true, acceptedTypes: '.jpg,.jpeg,.png' },
  { id: 'pdf-jpg', name: 'PDF to JPG', description: 'Extract images from your PDF or convert each page to a JPG.', icon: ImageIcon, color: 'text-yellow-400', multiple: false, acceptedTypes: '.pdf' },
  { id: 'rotate', name: 'Rotate PDF', description: 'Rotate your PDFs the way you need them.', icon: RotateCw, color: 'text-indigo-400', multiple: false, acceptedTypes: '.pdf' },
];

export default function FileActionsPage() {
  const [activeTool, setActiveTool] = useState<Tool | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  
  const [status, setStatus] = useState<'idle' | 'processing' | 'done'>('idle');
  const [progress, setProgress] = useState(0);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);
  const [resultFilename, setResultFilename] = useState<string>('');
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetState = () => {
    setFiles([]);
    setStatus('idle');
    setProgress(0);
    setResultBlob(null);
    setResultFilename('');
  };

  const handleToolClick = (tool: Tool) => {
    setActiveTool(tool);
    resetState();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFilesAdded(Array.from(e.target.files));
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      handleFilesAdded(Array.from(e.dataTransfer.files));
    }
  };

  const handleFilesAdded = (newFiles: File[]) => {
    if (activeTool?.multiple) {
      setFiles(prev => [...prev, ...newFiles]);
    } else {
      setFiles([newFiles[0]]);
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processFiles = async () => {
    if (files.length === 0 || !activeTool) return;
    
    setStatus('processing');
    setProgress(10);
    
    try {
      let finalBlob: Blob;
      let filename = `kfive_${activeTool.id}_${Date.now()}`;

      // NATIVE FRONTEND PROCESSING WITH PDF-LIB
      if (activeTool.id === 'merge') {
        const mergedPdf = await PDFDocument.create();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const arrayBuffer = await file.arrayBuffer();
          const pdfDoc = await PDFDocument.load(arrayBuffer);
          const copiedPages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
          copiedPages.forEach((page) => mergedPdf.addPage(page));
          setProgress(10 + Math.floor((i / files.length) * 80));
        }
        const pdfBytes = await mergedPdf.save();
        // @ts-ignore - TS types for pdf-lib Uint8Array
        finalBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        filename += '.pdf';

      } else if (activeTool.id === 'rotate') {
        const arrayBuffer = await files[0].arrayBuffer();
        const pdfDoc = await PDFDocument.load(arrayBuffer);
        const pages = pdfDoc.getPages();
        pages.forEach(page => {
          const currentRotation = page.getRotation().angle;
          page.setRotation(degrees(currentRotation + 90));
        });
        setProgress(80);
        const pdfBytes = await pdfDoc.save();
        // @ts-ignore
        finalBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        filename += '_rotated.pdf';

      } else if (activeTool.id === 'jpg-pdf') {
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const arrayBuffer = await file.arrayBuffer();
          let image;
          if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
            image = await pdfDoc.embedJpg(arrayBuffer);
          } else if (file.type === 'image/png') {
            image = await pdfDoc.embedPng(arrayBuffer);
          } else {
            continue;
          }
          const page = pdfDoc.addPage([image.width, image.height]);
          page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
          setProgress(10 + Math.floor((i / files.length) * 80));
        }
        const pdfBytes = await pdfDoc.save();
        // @ts-ignore
        finalBlob = new Blob([pdfBytes], { type: 'application/pdf' });
        filename += '.pdf';

      } else {
        // PROPRIETARY FORMATS (Word, Excel, PPT)
        // These require a real backend (e.g., LibreOffice, Pandoc).
        setProgress(40);
        const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
        const token = getToken();
        
        const formData = new FormData();
        files.forEach(f => formData.append('files', f));
        formData.append('toolId', activeTool.id);
        
        try {
          const response = await fetch(`${API_URL}/api/v1/documents/convert`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
          });

          if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(errBody.message || 'Server-side conversion failed natively.');
          }

          finalBlob = await response.blob();
          let ext = 'pdf';
          const targetFormat = activeTool.id.split('-').pop();
          if (targetFormat === 'word') ext = 'docx';
          else if (targetFormat === 'excel') ext = 'xlsx';
          else if (targetFormat === 'ppt') ext = 'pptx';
          else if (targetFormat === 'jpg') ext = 'jpg';
          else ext = targetFormat || 'pdf';
          
          filename += `.${ext}`;
          setProgress(90);
        } catch (err: any) {
          toast.error(err.message || 'Server-side conversion failed.');
          setStatus('idle');
          return;
        }
      }

      setProgress(100);
      setResultBlob(finalBlob);
      setResultFilename(filename);
      setStatus('done');
      toast.success(`${activeTool?.name} completed successfully!`);

    } catch (error) {
      console.error(error);
      toast.error('Failed to process file(s). Please check format.');
      setStatus('idle');
      setProgress(0);
    }
  };

  const triggerDownload = () => {
    if (!resultBlob) return;
    const element = document.createElement("a");
    element.href = URL.createObjectURL(resultBlob);
    element.download = resultFilename;
    document.body.appendChild(element); 
    element.click();
    document.body.removeChild(element);
    URL.revokeObjectURL(element.href);
    
    toast.success("File downloaded!");
  };

  return (
    <div className="p-6 md:p-8 flex flex-col h-full overflow-hidden">
      <AnimatePresence mode="wait">
        {!activeTool ? (
          <motion.div
            key="grid"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="space-y-8 flex-1 overflow-y-auto pb-10 scrollbar-thin overflow-x-hidden w-full max-w-7xl mx-auto"
          >
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
                <FolderOpen className="w-8 h-8 text-primary" />
                File Actions
              </h1>
              <p className="text-gray-400 mt-2 text-lg">
                Powerful document operations right in your browser safely and securely.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {TOOLS.map((tool) => (
                <motion.div
                  key={tool.id}
                  whileHover={{ y: -4 }}
                  onClick={() => handleToolClick(tool)}
                  className="bg-surface hover:bg-white/5 border border-border hover:border-primary/50 cursor-pointer rounded-2xl p-6 transition-all group relative overflow-hidden"
                >
                  <div className={`w-12 h-12 rounded-xl bg-black/20 flex items-center justify-center mb-4 border border-white/5 group-hover:border-white/10 transition-colors`}>
                    <tool.icon className={`w-6 h-6 ${tool.color}`} />
                  </div>
                  <h3 className="text-lg font-semibold text-white mb-2">{tool.name}</h3>
                  <p className="text-sm text-gray-400 group-hover:text-gray-300 transition-colors">{tool.description}</p>
                  
                  <div className="absolute right-4 top-4 p-2 bg-primary/10 rounded-full opacity-0 group-hover:opacity-100 transition-opacity translate-x-2 group-hover:translate-x-0">
                    <ArrowRight className="w-4 h-4 text-primary" />
                  </div>
                </motion.div>
              ))}
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="action"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="flex-1 flex flex-col max-w-4xl mx-auto w-full"
          >
            <button 
              onClick={() => setActiveTool(null)}
              className="flex items-center gap-2 text-gray-400 hover:text-white mb-8 group w-fit transition-colors"
            >
              <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
              Back to all tools
            </button>
            
            <div className="bg-surface border border-border rounded-2xl p-8 shadow-2xl flex-1 flex flex-col">
              <div className="flex items-center gap-4 mb-8 pb-8 border-b border-white/10">
                <div className="w-16 h-16 rounded-2xl bg-black/20 flex items-center justify-center border border-white/5">
                  <activeTool.icon className={`w-8 h-8 ${activeTool.color}`} />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-white">{activeTool.name}</h2>
                  <p className="text-gray-400 mt-1">{activeTool.description}</p>
                </div>
              </div>

              {status === 'idle' && (
                <div className="flex-1 flex flex-col">
                  {files.length === 0 ? (
                    <div 
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      className={`flex-1 min-h-[300px] border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${
                        isDragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-white/5'
                      }`}
                    >
                      <input 
                        type="file" 
                        ref={fileInputRef} 
                        onChange={handleFileChange} 
                        className="hidden" 
                        accept={activeTool.acceptedTypes}
                        multiple={activeTool.multiple}
                      />
                      <UploadCloud className={`w-16 h-16 mb-4 ${isDragging ? 'text-primary' : 'text-gray-500'}`} />
                      <h3 className="text-xl font-medium text-white mb-2">Select files</h3>
                      <p className="text-gray-400 max-w-xs text-center text-sm">
                        Drag and drop {activeTool.multiple ? 'files' : 'a file'} here, or click to browse.
                      </p>
                      <span className="mt-4 px-3 py-1 bg-black/40 border border-white/10 rounded-full text-xs text-gray-400">
                        Accepted: {activeTool.acceptedTypes}
                      </span>
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col">
                      <div className="flex justify-between items-end mb-4">
                        <h3 className="text-lg font-medium text-white">Files to process ({files.length})</h3>
                        {activeTool.multiple && (
                          <button 
                            onClick={() => fileInputRef.current?.click()}
                            className="text-sm text-primary hover:text-white transition-colors flex items-center gap-1"
                          >
                            <input 
                              type="file" 
                              ref={fileInputRef} 
                              onChange={handleFileChange} 
                              className="hidden" 
                              accept={activeTool.acceptedTypes}
                              multiple={activeTool.multiple}
                            />
                            + Add more files
                          </button>
                        )}
                      </div>
                      
                      <div className="grid grid-cols-1 gap-3 mb-6 max-h-[300px] overflow-y-auto pr-2 scrollbar-thin">
                        {files.map((f, i) => (
                          <div key={i} className="flex items-center justify-between p-4 bg-black/20 border border-white/5 rounded-xl hover:border-white/10 transition-colors">
                            <div className="flex items-center gap-3 overflow-hidden">
                              <FileIcon className="w-5 h-5 text-gray-400 shrink-0" />
                              <span className="text-sm font-medium text-white truncate">{f.name}</span>
                              <span className="text-xs text-gray-500 shrink-0">{(f.size / 1024 / 1024).toFixed(2)} MB</span>
                            </div>
                            <button 
                              onClick={() => removeFile(i)}
                              className="text-gray-500 hover:text-red-400 p-1 rounded-lg hover:bg-black/40 transition-colors"
                            >
                              &times;
                            </button>
                          </div>
                        ))}
                      </div>
                      
                      <div className="mt-auto flex justify-end gap-3 pt-6 border-t border-white/10">
                        <button 
                          onClick={resetState}
                          className="px-6 py-2.5 rounded-xl border border-border text-gray-300 hover:bg-white/5 font-medium transition-colors"
                        >
                          Cancel
                        </button>
                        <button 
                          onClick={processFiles}
                          className="px-8 py-2.5 rounded-xl bg-primary hover:bg-primary/90 text-white font-medium transition-colors flex items-center gap-2"
                        >
                          Process {files.length > 1 ? 'Files' : 'File'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {status === 'processing' && (
                <div className="flex-1 flex flex-col items-center justify-center py-12">
                  <div className="relative w-24 h-24 mb-8">
                    <svg className="animate-spin w-full h-full text-white/10" viewBox="0 0 24 24">
                       <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" />
                    </svg>
                    <svg className="animate-spin w-full h-full text-primary absolute left-0 top-0" style={{ animationDirection: 'reverse', animationDuration: '3s' }} viewBox="0 0 24 24">
                       <circle strokeDasharray="30 100" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-sm font-bold text-white">{Math.floor(progress)}%</span>
                    </div>
                  </div>
                  <h3 className="text-xl font-medium text-white mb-2">Processing Document...</h3>
                  <p className="text-gray-400">Please wait while we magically transform your {files.length > 1 ? 'files' : 'file'}.</p>
                  
                  <div className="w-full max-w-md bg-black/40 h-2 rounded-full mt-8 overflow-hidden border border-white/5">
                    <div 
                      className="bg-primary h-full rounded-full transition-all duration-75 relative overflow-hidden" 
                      style={{ width: `${progress}%` }}
                    >
                       <div className="absolute top-0 bottom-0 left-0 right-0 bg-white/20 animate-pulse"></div>
                    </div>
                  </div>
                </div>
              )}

              {status === 'done' && (
                <div className="flex-1 flex flex-col items-center justify-center py-12 animate-in zoom-in duration-500">
                  <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mb-6">
                    <CheckCircle className="w-10 h-10 text-green-400" />
                  </div>
                  <h3 className="text-2xl font-bold text-white mb-2">Task Complete!</h3>
                  <p className="text-gray-400 mb-8 max-w-sm text-center">
                    Your {files.length > 1 ? 'files have' : 'file has'} been successfully processed by KFive AI.
                  </p>
                  
                  <div className="flex flex-col sm:flex-row gap-4">
                    <button 
                      onClick={triggerDownload}
                      className="px-8 py-3 rounded-xl bg-primary hover:bg-primary/90 text-white font-medium transition-colors flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(37,99,235,0.3)]"
                    >
                      <Download className="w-5 h-5" />
                      Download Result
                    </button>
                    <button 
                      onClick={resetState}
                      className="px-8 py-3 rounded-xl border border-border text-gray-300 hover:bg-white/5 font-medium transition-colors"
                    >
                      Start Over
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
