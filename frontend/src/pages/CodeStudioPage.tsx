import React, { useState } from 'react';
import { Files, Search, GitBranch, Bug, Play, Check, Copy, MoreHorizontal, ChevronRight, FileCode2, Brain, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import Editor from '@monaco-editor/react';

export default function CodeStudioPage() {
  const [activeFile, setActiveFile] = useState('main.js');
  const [files, setFiles] = useState({
    'main.js': 'function helloWorld() {\n  console.log("Hello, KFive AI");\n}\n\nhelloWorld();',
    'utils.ts': 'export const add = (a: number, b: number) => a + b;\n',
    'style.css': 'body {\n  margin: 0;\n  background: #0f111a;\n}\n',
  });
  
  const [runOutput, setRunOutput] = useState('');
  const [aiOutput, setAiOutput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [copied, setCopied] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'terminal' | 'output' | 'ai'>('ai');

  const handleAction = async (action: 'run' | 'review' | 'fix') => {
    setActiveTab(action === 'run' ? 'output' : 'ai');
    setIsStreaming(action !== 'run');
    
    if (action === 'run') setRunOutput('');
    else setAiOutput('');
    
    try {
      toast.success(`${action} initiated`);
      const activeCode = files[activeFile as keyof typeof files] || '';
      
      if (action === 'run') {
         if (activeFile.endsWith('.js') || activeFile.endsWith('.ts')) {
           try {
             let execOutput = `> Executing ${activeFile}...\n`;
             const originalLog = console.log;
             console.log = (...args) => { execOutput += args.join(' ') + '\n'; };
             
             // Strip basic typescript keywords to execute clean JS in browser
             const jsCode = activeCode.replace(/export\s+const/g, 'const ').replace(/export\s+function/g, 'function ').replace(/: \w+/g, '');
             new Function(jsCode)();
             
             console.log = originalLog;
             execOutput += '[Process completed]\n';
             setRunOutput(execOutput);
           } catch (e: any) {
             setRunOutput(`> Executing ${activeFile}...\nError: ${e.message}\n[Process exited with error]`);
           }
         } else {
           setRunOutput(`> Executing ${activeFile}...\nCannot run non-JS/TS files natively in browser sandbox.\n[Process completed]`);
         }
         return;
      }

      let demoResponse = `AI Analysis (${action}):\n\nBased on your code in ${activeFile}:\n1. Structured successfully.\n2. No major issues found.\n\nCode is looking solid!`;
      
      for(let i=0; i<demoResponse.length; i+=3) {
        if (!isStreaming) break;
        await new Promise(r => setTimeout(r, 10));
        setAiOutput(prev => prev + demoResponse.substring(i, i+3));
      }
    } catch (error) {
      toast.error('Failed to run action');
    } finally {
      setIsStreaming(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(activeTab === 'output' || activeTab === 'terminal' ? runOutput : aiOutput);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getLanguage = (filename: string) => {
    if (filename.endsWith('.js')) return 'javascript';
    if (filename.endsWith('.ts')) return 'typescript';
    if (filename.endsWith('.css')) return 'css';
    if (filename.endsWith('.py')) return 'python';
    return 'plaintext';
  };

  return (
    <div className="h-full flex flex-col bg-[#1e1e1e] text-[#cccccc] font-sans">
      
      <div className="h-8 bg-[#323233] flex items-center px-4 text-xs select-none">
        <div className="flex gap-4">
          <span className="hover:text-white cursor-pointer">File</span>
          <span className="hover:text-white cursor-pointer">Edit</span>
          <span className="hover:text-white cursor-pointer">Selection</span>
          <span className="hover:text-white cursor-pointer">View</span>
          <span className="hover:text-white cursor-pointer">Go</span>
          <span className="hover:text-white cursor-pointer" onClick={() => handleAction('run')}>Run</span>
          <span className="hover:text-white cursor-pointer">Terminal</span>
        </div>
        <div className="mx-auto text-gray-400">{activeFile} - VS Code Studio</div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-12 bg-[#333333] flex flex-col items-center py-2 gap-4 shrink-0 border-r border-[#252526]">
          <div className="p-2 cursor-pointer border-l-2 border-[#007acc] text-white"><Files size={24} strokeWidth={1.5} /></div>
          <div className="p-2 cursor-pointer text-gray-500 hover:text-gray-300"><Search size={24} strokeWidth={1.5} /></div>
          <div className="p-2 cursor-pointer text-gray-500 hover:text-gray-300"><GitBranch size={24} strokeWidth={1.5} /></div>
          <div className="p-2 cursor-pointer text-gray-500 hover:text-gray-300"><Bug size={24} strokeWidth={1.5} /></div>
        </div>

        <div className="w-64 bg-[#252526] flex flex-col shrink-0">
          <div className="px-4 py-2 text-[11px] font-semibold text-gray-400 tracking-wider mt-2">EXPLORER</div>
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-[#2a2d2e] text-sm">
              <ChevronRight size={16} />
              <span className="font-bold">KFIVE-WORKSPACE</span>
            </div>
            <div className="pl-6 flex flex-col gap-0.5 mt-1">
              {Object.keys(files).map((file) => (
                <div 
                  key={file}
                  onClick={() => setActiveFile(file)}
                  className={`flex items-center gap-2 px-2 py-1 cursor-pointer text-sm transition-colors ${activeFile === file ? 'bg-[#37373d] text-white' : 'text-gray-300 hover:bg-[#2a2d2e]'}`}
                >
                  <FileCode2 size={14} className={file.endsWith('.js') ? 'text-yellow-400' : file.endsWith('.ts') ? 'text-blue-400' : 'text-cyan-400'} />
                  {file}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0 bg-[#1e1e1e]">
          <div className="flex bg-[#2d2d2d] h-9">
            {Object.keys(files).map(file => (
              <div 
                key={file}
                onClick={() => setActiveFile(file)}
                className={`flex items-center justify-center min-w-[120px] gap-2 px-4 h-full cursor-pointer text-sm border-r border-[#1e1e1e] ${activeFile === file ? 'bg-[#1e1e1e] text-white border-t border-t-[#007acc]' : 'text-gray-400 hover:bg-[#2b2b2b]'}`}
              >
                <FileCode2 size={14} className={file.endsWith('.js') ? 'text-yellow-400' : file.endsWith('.ts') ? 'text-blue-400' : 'text-cyan-400'} />
                {file}
              </div>
            ))}
            
            <div className="ml-auto flex items-center pr-4 gap-3 text-gray-400">
               <button onClick={() => handleAction('run')} className="hover:text-green-400 transition-colors bg-white/5 p-1 rounded" title="Run Code"><Play size={14} fill="currentColor" /></button>
               <button onClick={() => handleAction('review')} className="hover:text-purple-400 transition-colors bg-white/5 p-1 rounded" title="AI Review"><Brain size={14} /></button>
               <button onClick={() => handleAction('fix')} className="hover:text-cyan-400 transition-colors bg-white/5 p-1 rounded" title="Fix Bugs"><Bug size={14} /></button>
               <MoreHorizontal size={16} className="cursor-pointer hover:text-white ml-2" />
            </div>
          </div>
          
          <div className="flex-1 relative border-l border-[#333333]">
            <Editor
              height="100%"
              language={getLanguage(activeFile)}
              theme="vs-dark"
              value={files[activeFile as keyof typeof files]}
              onChange={(value) => setFiles(prev => ({...prev, [activeFile]: value || ''}))}
              options={{
                minimap: { enabled: true },
                fontSize: 14,
                fontFamily: "'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                padding: { top: 16 },
                cursorBlinking: "smooth",
                cursorSmoothCaretAnimation: "on",
                renderLineHighlight: 'all'
              }}
              loading={<div className="flex items-center justify-center w-full h-full text-gray-500 font-mono text-sm">Loading VS Code Core...</div>}
            />
          </div>

          <div className="h-64 border-t border-[#333333] border-l flex flex-col bg-[#1e1e1e] shrink-0">
            <div className="flex items-center gap-6 px-4 h-9 uppercase text-[11px] tracking-wider font-medium border-b border-[#333333]">
              <span onClick={() => setActiveTab('output')} className={`cursor-pointer h-full flex items-center ${activeTab === 'output' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}`}>Output</span>
              <span onClick={() => setActiveTab('terminal')} className={`cursor-pointer h-full flex items-center ${activeTab === 'terminal' ? 'text-white border-b-2 border-white' : 'text-gray-500 hover:text-gray-300'}`}>Terminal</span>
              <span onClick={() => setActiveTab('ai')} className={`cursor-pointer h-full flex items-center gap-1.5 ${activeTab === 'ai' ? 'text-purple-400 border-b-2 border-purple-400' : 'text-gray-500 hover:text-gray-300'}`}><Brain size={12}/> KFive AI</span>
              
              <div className="ml-auto flex items-center gap-2">
                 <button onClick={handleCopy} className="text-gray-500 hover:text-white p-1 rounded hover:bg-white/10 transition-colors">
                   {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                 </button>
              </div>
            </div>
            
            <div className="flex-1 p-4 font-mono text-sm overflow-auto text-gray-300 whitespace-pre-wrap">
               {activeTab === 'terminal' && (
                 <div className="text-gray-400">KFive Terminal v1.0.0<br/>lenovo@kfive-workspace:~$ <span className="animate-pulse">_</span></div>
               )}
               {activeTab === 'output' && (
                 <div className="text-gray-300">
                   {runOutput || <span className="text-gray-400">No output available. Click 'Run' to execute the active file.</span>}
                 </div>
               )}
               {activeTab === 'ai' && (
                 <div className="text-gray-300 relative">
                   {isStreaming && <span className="absolute -left-3 top-1.5 w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse"></span>}
                   {aiOutput || <span className="text-gray-500">Select an action like 'Review' or 'Fix Bugs' in the top right to unleash AI on your code.</span>}
                 </div>
               )}
            </div>
          </div>
          
        </div>
      </div>

      <div className="h-6 bg-[#007acc] text-white flex items-center px-4 text-xs justify-between shrink-0">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-1 cursor-pointer hover:bg-white/20 px-1 rounded transition-colors"><GitBranch size={12} /> main</span>
          <span className="flex items-center gap-1 cursor-pointer hover:bg-white/20 px-1 rounded transition-colors"><Check size={12} /> 0 <AlertCircle size={12} className="ml-1"/> 0</span>
        </div>
        <div className="flex items-center gap-5">
          <span className="cursor-pointer hover:bg-white/20 px-1 rounded transition-colors">{getLanguage(activeFile) === 'javascript' ? 'JavaScript' : getLanguage(activeFile) === 'typescript' ? 'TypeScript' : getLanguage(activeFile) === 'css' ? 'CSS' : 'Plain Text'}</span>
          <span className="cursor-pointer hover:bg-white/20 px-1 rounded transition-colors">UTF-8</span>
          <span className="cursor-pointer hover:bg-white/20 px-1 rounded transition-colors">Prettier</span>
        </div>
      </div>
    </div>
  );
}