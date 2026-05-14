import { Briefcase, FilePlus, Target, ArrowRight } from 'lucide-react';
import { useState } from 'react';

export default function ResumeActionsPage() {
  const [activeTab, setActiveTab] = useState<'selection' | 'generator' | 'ats'>('selection');

  return (
    <div className="p-6 md:p-8 flex flex-col h-full overflow-hidden">
      <div className="max-w-7xl mx-auto w-full space-y-8 flex-1 overflow-y-auto pb-10 scrollbar-thin overflow-x-hidden">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
            <Briefcase className="w-8 h-8 text-primary" />
            Resume Actions
          </h1>
          <p className="text-gray-400 mt-2 text-lg">
            AI-powered resume building and professional ATS analysis tools.
          </p>
        </div>

        {activeTab === 'selection' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-8">
            {/* Resume Generator Card */}
            <div 
              onClick={() => setActiveTab('generator')}
              className="bg-surface hover:bg-white/5 border border-border hover:border-primary/50 cursor-pointer rounded-2xl p-8 transition-all group relative overflow-hidden flex flex-col shadow-lg"
            >
              <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-6 border border-blue-500/20 group-hover:border-blue-500/40 transition-colors">
                <FilePlus className="w-8 h-8 text-blue-400" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-3">Resume Generator</h2>
              <p className="text-gray-400 group-hover:text-gray-300 transition-colors font-light leading-relaxed flex-1">
                Construct an enterprise-grade resume using AI. Select professional templates and let KFive structurally optimize your data natively.
              </p>
              <div className="mt-8 flex items-center text-primary font-medium">
                Launch Generator
                <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-2 transition-transform" />
              </div>
            </div>

            {/* ATS Score Checker Card */}
            <div 
              onClick={() => setActiveTab('ats')}
              className="bg-surface hover:bg-white/5 border border-border hover:border-green-500/50 cursor-pointer rounded-2xl p-8 transition-all group relative overflow-hidden flex flex-col shadow-lg"
            >
              <div className="w-16 h-16 rounded-2xl bg-green-500/10 flex items-center justify-center mb-6 border border-green-500/20 group-hover:border-green-500/40 transition-colors">
                <Target className="w-8 h-8 text-green-400" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-3">ATS Score Checker</h2>
              <p className="text-gray-400 group-hover:text-gray-300 transition-colors font-light leading-relaxed flex-1">
                Upload your existing resume and a target job description. KFive will run an intensive semantic ATS analysis to determine your match probability and highlight missing keywords.
              </p>
              <div className="mt-8 flex items-center text-green-400 font-medium">
                Analyze Resume
                <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-2 transition-transform" />
              </div>
            </div>
          </div>
        )}

        {/* Action Pages */}
        {activeTab !== 'selection' && (
          <div className="bg-surface border border-border rounded-2xl p-10 shadow-2xl flex flex-col items-center justify-center min-h-[450px] text-center relative animate-in fade-in slide-in-from-bottom-4 duration-500">
              <button 
                onClick={() => setActiveTab('selection')}
                className="absolute top-6 left-6 text-gray-400 hover:text-white flex items-center gap-2 group transition-colors bg-white/5 border border-white/10 px-4 py-2 rounded-lg"
              >
                <ArrowRight className="w-4 h-4 rotate-180 group-hover:-translate-x-1 transition-transform" />
                Back to Options
              </button>

              {activeTab === 'generator' ? (
                <FilePlus className="w-20 h-20 text-blue-400 mb-6" />
              ) : (
                <Target className="w-20 h-20 text-green-400 mb-6" />
              )}
              
              <h2 className="text-3xl font-semibold text-white mb-4">
                {activeTab === 'generator' ? 'Resume Generation Studio' : 'Semantic ATS Analysis Engine'}
              </h2>
              <p className="text-gray-400 max-w-lg mx-auto text-lg leading-relaxed">
                This powerful module is currently being finalized. Once active, it will securely process your documents strictly on your local machine, keeping your personal work history 100% private.
              </p>
          </div>
        )}
      </div>
    </div>
  );
}
