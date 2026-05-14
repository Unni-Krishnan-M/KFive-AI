import React from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Bot, Home } from 'lucide-react';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#09090B] flex flex-col items-center justify-center p-6 text-white text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="max-w-md w-full flex flex-col items-center"
      >
        <div className="relative mb-8">
          <div className="absolute inset-0 bg-primary/20 blur-3xl rounded-full"></div>
          <Bot size={120} className="text-primary relative z-10 drop-shadow-[0_0_15px_rgba(139,92,246,0.5)]" />
        </div>
        
        <h1 className="text-7xl font-bold font-mono tracking-tighter mb-4 text-transparent bg-clip-text bg-gradient-to-r from-primary to-cyan-400">
          404
        </h1>
        
        <h2 className="text-2xl font-semibold mb-3">System Malfunction</h2>
        
        <p className="text-gray-400 mb-8 max-w-sm">
          It seems this node doesn't exist in the network. The AI agent got a little confused trying to route you here.
        </p>
        
        <button
          onClick={() => navigate('/app/dashboard')}
          className="flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-primary to-purple-600 rounded-xl font-medium hover:opacity-90 transition-opacity focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-[#09090B]"
          aria-label="Go Home"
        >
          <Home size={18} />
          <span>Return Home</span>
        </button>
      </motion.div>
    </div>
  );
}
