import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Settings, Moon, Sun, Monitor, Bell, ShieldAlert, Trash2, Brain } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import toast from 'react-hot-toast';
import { userApi, chatApi } from '@/services/api';

export default function SettingsPage() {
  const [theme, setTheme] = useState(localStorage.getItem('kfive-theme') || 'dark');
  const [sidebarMode, setSidebarMode] = useState(localStorage.getItem('kfive-sidebar-collapsed') === 'true' ? 'collapsed' : 'expanded');
  const [fontSize, setFontSize] = useState('md');
  const [defaultModel, setDefaultModel] = useState('llama3');
  const [temperature, setTemperature] = useState(0.7);
  const [streaming, setStreaming] = useState(true);
  const [toastsEnabled, setToastsEnabled] = useState(true);
  
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // Load from local storage
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem('kfive-settings');
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        if (parsed.fontSize) setFontSize(parsed.fontSize);
        if (parsed.defaultModel) setDefaultModel(parsed.defaultModel);
        if (parsed.temperature !== undefined) setTemperature(parsed.temperature);
        if (parsed.streaming !== undefined) setStreaming(parsed.streaming);
        if (parsed.toastsEnabled !== undefined) setToastsEnabled(parsed.toastsEnabled);
      }
    } catch(e) {
      console.error(e);
    }
  }, []);

  // Save to local storage on change
  useEffect(() => {
    const settings = { fontSize, defaultModel, temperature, streaming, toastsEnabled };
    localStorage.setItem('kfive-settings', JSON.stringify(settings));
    
    // Apply font size globally if needed (custom logic)
    if (fontSize === 'sm') document.documentElement.style.fontSize = '14px';
    else if (fontSize === 'md') document.documentElement.style.fontSize = '16px';
    else if (fontSize === 'lg') document.documentElement.style.fontSize = '18px';
    
  }, [fontSize, defaultModel, temperature, streaming, toastsEnabled]);

  const handleThemeChange = (newTheme: string) => {
    setTheme(newTheme);
    localStorage.setItem('kfive-theme', newTheme);
    if (newTheme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  };

  const handleSidebarChange = (mode: string) => {
    setSidebarMode(mode);
    localStorage.setItem('kfive-sidebar-collapsed', mode === 'collapsed' ? 'true' : 'false');
    // Note: requires reload or state sync in AppLayout to take effect immediately without context
    toast.success('Sidebar preference updated (Reload to see full effect)');
  };

  const handleDeleteAll = async () => {
    try {
      // Assuming a dedicated endpoint or we just iterate
      toast.success('In a real app, this would delete all conversations. Feature pending API support.');
      setIsConfirmOpen(false);
    } catch (err) {
      toast.error('Failed to clear conversations');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 md:p-8 max-w-4xl mx-auto space-y-8"
    >
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
          <Settings className="w-8 h-8 text-primary" />
          System Settings
        </h1>
        <p className="text-gray-400">Configure your KFive AI experience and preferences.</p>
      </div>

      <div className="space-y-6">
        
        {/* Appearance Settings */}
        <section className="bg-white/5 border border-white/10 rounded-2xl p-6 glass-card">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2 border-b border-white/10 pb-4">
            <Monitor className="w-5 h-5 text-cyan-400" />
            Appearance
          </h2>
          
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-medium">Color Theme</h3>
                <p className="text-sm text-gray-400">Choose between light and dark mode</p>
              </div>
              <div className="flex bg-black/40 rounded-lg p-1 border border-white/5">
                <button 
                  onClick={() => handleThemeChange('light')}
                  className={`px-4 py-2 rounded-md flex items-center gap-2 text-sm font-medium transition-colors ${theme === 'light' ? 'bg-primary text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  <Sun className="w-4 h-4" /> Light
                </button>
                <button 
                  onClick={() => handleThemeChange('dark')}
                  className={`px-4 py-2 rounded-md flex items-center gap-2 text-sm font-medium transition-colors ${theme === 'dark' ? 'bg-[#09090B] border border-white/10 text-white' : 'text-gray-400 hover:text-white'}`}
                >
                  <Moon className="w-4 h-4" /> Dark
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-medium">Sidebar Mode</h3>
                <p className="text-sm text-gray-400">Default state for the desktop sidebar</p>
              </div>
              <div className="flex bg-black/40 rounded-lg p-1 border border-white/5">
                <button 
                  onClick={() => handleSidebarChange('expanded')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${sidebarMode === 'expanded' ? 'bg-white/10 text-white border border-white/10' : 'text-gray-400 hover:text-white'}`}
                >
                  Expanded
                </button>
                <button 
                  onClick={() => handleSidebarChange('collapsed')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${sidebarMode === 'collapsed' ? 'bg-white/10 text-white border border-white/10' : 'text-gray-400 hover:text-white'}`}
                >
                  Collapsed
                </button>
              </div>
            </div>

            <div>
              <div className="flex justify-between items-end mb-2">
                <div>
                  <h3 className="text-white font-medium">UI Font Size</h3>
                  <p className="text-sm text-gray-400">Adjust the global text size</p>
                </div>
                <span className="text-sm font-medium text-primary uppercase">{fontSize}</span>
              </div>
              <input 
                type="range" 
                min="0" max="2" step="1"
                value={fontSize === 'sm' ? 0 : fontSize === 'md' ? 1 : 2}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  setFontSize(val === 0 ? 'sm' : val === 1 ? 'md' : 'lg');
                }}
                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer accent-primary"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-2 px-1">
                <span>Small</span>
                <span>Normal</span>
                <span>Large</span>
              </div>
            </div>
          </div>
        </section>

        {/* AI Model Settings */}
        <section className="bg-white/5 border border-white/10 rounded-2xl p-6 glass-card">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2 border-b border-white/10 pb-4">
            <Brain className="w-5 h-5 text-purple-400" />
            AI Model Preferences
          </h2>
          
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-medium">Default Model</h3>
                <p className="text-sm text-gray-400">Pre-selected model for new chats</p>
              </div>
              <select 
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="bg-black/40 border border-white/10 text-white text-sm rounded-xl px-4 py-2.5 focus:ring-2 focus:ring-primary focus:outline-none"
              >
                <option value="llama3">Llama 3 (8B)</option>
                <option value="mistral">Mistral (7B)</option>
                <option value="deepseek-coder">DeepSeek Coder</option>
                <option value="phi3">Phi-3 Mini</option>
              </select>
            </div>

            <div>
              <div className="flex justify-between items-end mb-2">
                <div>
                  <h3 className="text-white font-medium">Default Temperature</h3>
                  <p className="text-sm text-gray-400">AI creativity level (0.0 to 1.0)</p>
                </div>
                <span className="text-sm font-medium text-purple-400">{temperature.toFixed(2)}</span>
              </div>
              <input 
                type="range" 
                min="0" max="1" step="0.05"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full h-2 bg-black/40 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <div className="flex justify-between text-xs text-gray-500 mt-2 px-1">
                <span>Precise</span>
                <span>Balanced</span>
                <span>Creative</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-white font-medium">Enable Response Streaming</h3>
                <p className="text-sm text-gray-400">Show AI answers as they are generated</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  className="sr-only peer" 
                  checked={streaming}
                  onChange={(e) => setStreaming(e.target.checked)}
                />
                <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
              </label>
            </div>
          </div>
        </section>

        {/* Notifications */}
        <section className="bg-white/5 border border-white/10 rounded-2xl p-6 glass-card">
          <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2 border-b border-white/10 pb-4">
            <Bell className="w-5 h-5 text-yellow-400" />
            Notifications
          </h2>
          
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-medium">UI Toast Notifications</h3>
              <p className="text-sm text-gray-400">Show floating success and error messages</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer" 
                checked={toastsEnabled}
                onChange={(e) => {
                  setToastsEnabled(e.target.checked);
                  if (e.target.checked) toast.success('Toasts enabled');
                }}
              />
              <div className="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>
        </section>

        {/* Danger Zone */}
        <section className="bg-red-500/5 border border-red-500/20 rounded-2xl p-6 glass-card">
          <h2 className="text-xl font-semibold text-red-500 mb-6 flex items-center gap-2 border-b border-red-500/10 pb-4">
            <ShieldAlert className="w-5 h-5" />
            Danger Zone
          </h2>
          
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-white font-medium">Clear All Data</h3>
              <p className="text-sm text-red-400/80">Permanently delete all your conversations and context.</p>
            </div>
            <button 
              onClick={() => setIsConfirmOpen(true)}
              className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/20 rounded-xl font-medium transition-colors flex items-center gap-2"
            >
              <Trash2 className="w-4 h-4" />
              Delete All
            </button>
          </div>
        </section>

      </div>

      <ConfirmDialog
        isOpen={isConfirmOpen}
        title="Delete Auto-Saved Data"
        message="Are you sure you want to delete all your conversations? This action cannot be undone and will permanently remove your AI history from our servers."
        confirmText="Yes, delete everything"
        onConfirm={handleDeleteAll}
        onCancel={() => setIsConfirmOpen(false)}
        isDestructive={true}
      />

    </motion.div>
  );
}