import React from 'react';

interface SkeletonLoaderProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

export function SkeletonLoader({ className = '', ...props }: SkeletonLoaderProps) {
  return (
    <div 
      className={`animate-pulse bg-white/5 rounded-md ${className}`} 
      {...props} 
    />
  );
}
