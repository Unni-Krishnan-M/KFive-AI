import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDestructive?: boolean;
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
  isDestructive = false,
}: ConfirmDialogProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={onCancel}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-[#09090B] border border-white/10 rounded-xl shadow-2xl p-6 z-50 backdrop-blur-xl"
          >
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-xl font-semibold text-white">{title}</h2>
              <button
                onClick={onCancel}
                className="text-gray-400 hover:text-white transition-colors"
                aria-label="Close dialog"
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-gray-300 mb-6">{message}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={onCancel}
                className="px-4 py-2 rounded-lg font-medium text-gray-300 hover:text-white hover:bg-white/5 transition-colors focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {cancelText}
              </button>
              <button
                onClick={onConfirm}
                className={`px-4 py-2 rounded-lg font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090B] ${
                  isDestructive
                    ? 'bg-red-500 hover:bg-red-600 text-white focus-visible:ring-red-500'
                    : 'bg-primary hover:bg-primary/90 text-white focus-visible:ring-primary'
                }`}
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
