import { motion } from 'framer-motion';
import { Brain, Loader2 } from 'lucide-react';

export function LoadingScreen() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <motion.div 
        className="text-center"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
      >
        <motion.div 
          className="w-16 h-16 bg-gradient-to-r from-primary to-purple-500 rounded-xl flex items-center justify-center mb-6 mx-auto"
          animate={{ 
            rotate: 360,
            scale: [1, 1.1, 1]
          }}
          transition={{ 
            rotate: { duration: 2, repeat: Infinity, ease: "linear" },
            scale: { duration: 1, repeat: Infinity, ease: "easeInOut" }
          }}
        >
          <Brain className="w-8 h-8 text-white" />
        </motion.div>
        
        <h2 className="text-2xl font-bold gradient-text mb-2">KFive AI</h2>
        <p className="text-muted-foreground mb-4">Initializing AI workspace...</p>
        
        <div className="flex items-center justify-center space-x-2">
          <Loader2 className="w-4 h-4 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Loading</span>
        </div>
      </motion.div>
    </div>
  );
}