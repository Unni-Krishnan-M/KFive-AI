import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { 
  Brain, Shield, Smartphone, MessageSquare, 
  ArrowRight, Sparkles, Terminal, Activity, Menu, X, Users, Zap, Code
} from 'lucide-react';

export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background Particle Effects Canvas */}
      <div id="particle-canvas" />

      {/* Cyber Grid Background overlay */}
      <div className="absolute inset-0 z-[-1] pointer-events-none"
           style={{
             backgroundImage: 'linear-gradient(rgba(139, 92, 246, 0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(139, 92, 246, 0.03) 1px, transparent 1px)',
             backgroundSize: '40px 40px'
           }}
      />

      {/* Premium AI Navbar */}
      <nav className={`glass-navbar ${scrolled ? 'py-3 shadow-lg' : 'py-5 bg-transparent border-transparent'} px-6 lg:px-12`}>
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <motion.div 
            className="flex items-center space-x-3 cursor-pointer"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-surface border border-primary/30 overflow-hidden group">
              <div className="absolute inset-0 bg-primary/20 group-hover:bg-primary/40 transition-colors" />
              <Brain className="w-6 h-6 text-primary z-10" />
            </div>
            <span className="text-2xl font-bold tracking-tight text-white">KFive<span className="text-primary">.AI</span></span>
          </motion.div>
          
          {/* Desktop Nav */}
          <motion.div 
            className="hidden md:flex flex-1 items-center justify-center space-x-8"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
          >
            {['Features', 'Agents', 'Workspace', 'Enterprise'].map((item) => (
              <a key={item} href={`#${item.toLowerCase()}`} className="text-sm font-medium text-text-secondary hover:text-white transition-colors">
                {item}
              </a>
            ))}
          </motion.div>

          <motion.div 
            className="hidden md:flex items-center space-x-4"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.6 }}
          >
            <Link to="/login" className="text-sm font-medium text-white hover:text-primary transition-colors">
              Sign In
            </Link>
            <Link to="/register" className="premium-button-primary">
              Launch Workspace
            </Link>
          </motion.div>

          {/* Mobile Menu Toggle */}
          <div className="md:hidden flex items-center">
            <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="text-white p-2">
              {mobileMenuOpen ? <X /> : <Menu />}
            </button>
          </div>
        </div>

        {/* Mobile Nav Dropdown */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="md:hidden overflow-hidden bg-[#09090B]/95 backdrop-blur-xl border-b border-border absolute top-full left-0 right-0"
            >
              <div className="flex flex-col p-6 space-y-4">
                {['Features', 'Agents', 'Workspace', 'Enterprise'].map((item) => (
                  <a key={item} href={`#${item.toLowerCase()}`} className="text-lg font-medium text-text-secondary hover:text-white transition-colors" onClick={() => setMobileMenuOpen(false)}>
                    {item}
                  </a>
                ))}
                <div className="pt-4 border-t border-border flex flex-col space-y-3">
                  <Link to="/login" className="premium-button border border-border text-center">Sign In</Link>
                  <Link to="/register" className="premium-button-primary w-full">Launch Workspace</Link>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      <main className="pt-32 pb-20 px-6 lg:px-12 max-w-7xl mx-auto space-y-40">
        
        {/* Animated Hero Section */}
        <section className="relative flex flex-col lg:flex-row items-center justify-between gap-16 min-h-[70vh]">
          <div className="flex-1 text-center lg:text-left z-10">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: "easeOut" }}
              className="space-y-6"
            >
              <div className="inline-flex items-center space-x-2 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-semibold tracking-wide uppercase mb-4">
                <Sparkles className="w-3.5 h-3.5" />
                <span>Next-Gen Operating System</span>
              </div>
              
              <h1 className="text-5xl md:text-7xl lg:text-[5.5rem] font-bold leading-[1.1] tracking-tight text-white text-balance">
                The Operating System for <br className="hidden lg:block"/>
                <span className="gradient-text tracking-tighter">Superintelligence.</span>
              </h1>
              
              <p className="text-lg md:text-xl text-text-secondary max-w-2xl mx-auto lg:mx-0 leading-relaxed font-light">
                A localized, hyper-performant AI workspace powered by autonomous agents, memory, and spatial computing interfaces. Execute commands at the speed of thought.
              </p>
              
              <div className="flex flex-col sm:flex-row items-center justify-center lg:justify-start gap-4 pt-6">
                <Link to="/register" className="premium-button-primary w-full sm:w-auto text-lg px-8 py-4 group">
                  <span>Initialize System</span>
                  <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                </Link>
                <button className="premium-button-secondary w-full sm:w-auto text-lg px-8 py-4 flex items-center justify-center gap-2">
                  <Terminal className="w-5 h-5" />
                  <span>View Documentation</span>
                </button>
              </div>
            </motion.div>
          </div>

          <div className="flex-1 relative lg:h-[600px] w-full flex items-center justify-center">
            {/* Floating AI Assistant Orb */}
            <motion.div 
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1, delay: 0.2 }}
              className="ai-orb-container"
            >
              <div className="ai-orb" />
            </motion.div>

            {/* Floating Chat/Process Cards */}
            <motion.div 
              initial={{ opacity: 0, y: 50 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.6 }}
              className="absolute top-1/4 left-0 lg:-left-12 glass-panel p-4 pb-5 rounded-2xl w-64 hidden md:block animate-float"
              style={{ animationDelay: '0.5s' }}
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
                  <Brain className="w-4 h-4 text-primary" />
                </div>
                <div className="text-sm font-medium text-white">System Core</div>
              </div>
              <div className="space-y-2">
                <div className="h-2 w-3/4 bg-surface rounded-full overflow-hidden relative">
                   <div className="absolute top-0 left-0 bottom-0 bg-primary w-full animate-[typing_2s_ease-in-out_infinite]" />
                </div>
                <div className="h-2 w-1/2 bg-surface rounded-full" />
              </div>
            </motion.div>
            
            <motion.div 
              initial={{ opacity: 0, y: -50 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.8 }}
              className="absolute bottom-1/4 right-0 lg:-right-12 glass-panel p-4 rounded-2xl w-56 hidden md:block animate-float"
              style={{ animationDelay: '1.5s', animationDirection: 'reverse' }}
            >
              <div className="flex items-center gap-3">
                <Activity className="w-5 h-5 text-secondary" />
                <span className="text-sm font-medium">Neural Link Active</span>
              </div>
              <div className="mt-3 text-xs text-text-secondary">Latency: 12ms</div>
            </motion.div>
          </div>
        </section>

        {/* Glassmorphism Feature Cards Section */}
        <section id="features" className="relative z-10">
          <div className="text-center mb-20">
            <h2 className="text-3xl md:text-5xl font-bold mb-6 tracking-tight">Architected for <span className="gradient-text">Excellence</span></h2>
            <p className="text-text-secondary text-lg max-w-2xl mx-auto">Every component is engineered to reduce friction and instantly transform thoughts into reality.</p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-8">
            {features.map((feature, idx) => (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.5, delay: idx * 0.1 }}
                className="glass-card p-8 flex flex-col h-full relative overflow-hidden"
              >
                {/* Custom Hover Glow derived from feature hex */}
                <div className="absolute inset-0 opacity-0 hover:opacity-10 transition-opacity duration-300 pointer-events-none" style={{ backgroundColor: feature.hexCode }} />
                
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-6 bg-surface border border-white/5 relative z-10">
                  <feature.icon className="w-7 h-7" style={{ color: feature.hexCode }} />
                </div>
                <h3 className="text-xl font-semibold text-white mb-3 tracking-tight relative z-10">{feature.title}</h3>
                <p className="text-text-secondary leading-relaxed font-light m-0 flex-1 relative z-10">{feature.description}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Realtime AI Chat Preview / Workspace Section */}
        <section id="workspace" className="relative z-10 my-32">
           <motion.div 
             initial={{ opacity: 0 }}
             whileInView={{ opacity: 1 }}
             viewport={{ once: true }}
             className="glass-panel p-1 rounded-3xl overflow-hidden border border-border/50 shadow-2xl relative"
           >
              {/* Premium Mac-like Window Header */}
              <div className="bg-[#0b0f19] px-6 py-4 border-b border-border flex items-center gap-2">
                 <div className="w-3 h-3 rounded-full bg-red-500/80" />
                 <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                 <div className="w-3 h-3 rounded-full bg-green-500/80" />
                 <div className="mx-auto text-xs font-mono text-text-secondary flex items-center gap-2">
                    <Shield className="w-3 h-3" />
                    LOCAL_WORKSPACE_SECURE
                 </div>
              </div>
              {/* Preview Body */}
              <div className="bg-[#09090B]/90 p-8 min-h-[400px] flex flex-col md:flex-row gap-8">
                 <div className="flex-1 space-y-6">
                   <div className="glass-panel p-4 self-start max-w-[80%]">
                     <p className="text-sm">Initiate the web scraper protocol for the tech domains.</p>
                   </div>
                   <div className="glass-panel p-4 bg-primary/10 border-primary/20 self-end max-w-[80%] ml-auto relative">
                     <p className="text-sm font-mono text-primary mb-2 flex items-center gap-2">
                       <Activity className="w-4 h-4 animate-spin-slow" /> Executing Protocol...
                     </p>
                     <p className="text-text-secondary text-sm">Successfully initialized 4 agents. Constructing data pipelines for domain analysis.</p>
                   </div>
                 </div>
                 <div className="hidden md:block w-72 glass-panel p-5 space-y-4">
                   <div className="text-xs uppercase font-bold text-text-secondary mb-4 tracking-widest">Active Agents</div>
                   {[1,2,3].map(i => (
                     <div key={i} className="flex items-center gap-3 p-2 hover:bg-surface rounded-lg cursor-pointer transition-colors">
                       <div className="w-8 h-8 rounded-full bg-accent/20 flex flex-shrink-0 items-center justify-center">
                         <Terminal className="w-4 h-4 text-accent" />
                       </div>
                       <div className="w-full">
                         <div className="text-sm text-white font-medium">Worker_0{i}</div>
                         <div className="h-1 w-full bg-surface rounded-full mt-1 overflow-hidden">
                           <div className="h-full bg-accent" style={{width: `${Math.random() * 60 + 30}%`}} />
                         </div>
                       </div>
                     </div>
                   ))}
                 </div>
              </div>
           </motion.div>
        </section>

        {/* Animated Stats Section */}
        <section className="relative z-10 py-10">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {[
              { label: 'Latency', value: '< 10ms', icon: Zap },
              { label: 'Active Orbs', value: '14.2M', icon: Activity },
              { label: 'LLM Context', value: '1M+ Tkns', icon: Brain },
              { label: 'Global Nodes', value: '8,402', icon: Users }
            ].map((stat, idx) => (
              <motion.div 
                key={stat.label}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ delay: idx * 0.1, duration: 0.5 }}
                className="flex flex-col items-center justify-center text-center p-6 glass-panel border-white/5 hover:border-primary/20 transition-colors"
              >
                <stat.icon className="w-8 h-8 text-primary mb-4 opacity-80" />
                <h4 className="text-3xl font-bold text-white mb-2">{stat.value}</h4>
                <p className="text-sm text-text-secondary font-medium tracking-wide uppercase">{stat.label}</p>
              </motion.div>
            ))}
          </div>
        </section>

        {/* Footer CTA */}
        <section className="text-center max-w-4xl mx-auto pb-20">
          <motion.div
             initial={{ opacity: 0, scale: 0.95 }}
             whileInView={{ opacity: 1, scale: 1 }}
             viewport={{ once: true }}
             className="glass-card p-12 md:p-20 rounded-[2rem] relative overflow-hidden"
          >
             <div className="absolute top-0 right-0 w-64 h-64 bg-primary/20 blur-[100px] rounded-full" />
             <div className="absolute bottom-0 left-0 w-64 h-64 bg-secondary/20 blur-[100px] rounded-full" />
             
             <div className="relative z-10 text-center">
               <h2 className="text-4xl md:text-5xl font-bold mb-6 tracking-tight text-white">Enter the <br className="md:hidden" />New Paradigm.</h2>
               <p className="text-xl text-text-secondary mb-10 max-w-xl mx-auto font-light">Join the elite faction of developers pioneering localized, hyper-advanced AI environments without limitations.</p>
               <Link to="/register" className="premium-button-primary px-10 py-5 text-lg group w-full md:w-auto">
                 <span>Deploy Your Workspace</span>
                 <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
               </Link>
             </div>
          </motion.div>
        </section>
      </main>

      {/* Smooth Footer */}
      <footer className="border-t border-border/50 bg-[#09090B]/80 backdrop-blur-lg">
        <div className="max-w-7xl mx-auto px-6 py-12 flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center space-x-2">
            <Brain className="w-5 h-5 text-text-secondary" />
            <span className="font-semibold text-text-secondary">KFive AI OS</span>
          </div>
          <p className="text-sm text-text-secondary">
            &copy; {new Date().getFullYear()} KFive Systems. Immersive Intelligence.
          </p>
          <div className="flex space-x-6 text-sm font-medium text-text-secondary">
            <a href="#" className="hover:text-white transition-colors">Privacy</a>
            <a href="#" className="hover:text-white transition-colors">Terms</a>
            <a href="#" className="hover:text-white transition-colors">System Status</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

const features = [
  {
    icon: Brain,
    title: 'Autonomous Swarms',
    description: 'Deploy arrays of specialized agents that orchestrate natively, breaking down complex prompts into parallelized pipelines.',
    hexCode: '#8B5CF6' // Primary
  },
  {
    icon: Shield,
    title: 'Absolute Privacy',
    description: 'Everything executes locally via advanced Ollama runtime integrations. Zero external telemetry. Complete sovereignty.',
    hexCode: '#06B6D4' // Secondary
  },
  {
    icon: Code,
    title: 'Code Generation Studio',
    description: 'Bypass conventional text interfaces with an immersive IDE integrated natively with your agentic workflows.',
    hexCode: '#3B82F6' // Accent
  },
  {
    icon: Smartphone,
    title: 'Omnipresent Sync',
    description: 'A deeply integrated Progressive Web App environment for seamless continuity across your mobile and desktop spaces.',
    hexCode: '#10B981'
  },
  {
    icon: MessageSquare,
    title: 'Cognitive Memory',
    description: 'Vector-embedded conversation states persist effortlessly, granting your AI perfect recall of all project context.',
    hexCode: '#F59E0B'
  },
  {
    icon: Activity,
    title: 'Spatial UI System',
    description: 'Interact with visual, draggable node-based flows to orchestrate AI pipelines directly on your operational canvas.',
    hexCode: '#EC4899'
  }
];