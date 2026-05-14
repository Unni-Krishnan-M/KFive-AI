import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Save, User as UserIcon, Mail, Shield, Zap, MessageSquare, FileText, Activity } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { userApi } from '@/services/api';
import toast from 'react-hot-toast';
import { SkeletonLoader } from '@/components/ui/SkeletonLoader';

export default function ProfilePage() {
  const { user, updateUser } = useAuth();
  
  const [formData, setFormData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    username: user?.username || ''
  });
  const [isSaving, setIsSaving] = useState(false);
  const [usageData, setUsageData] = useState<any>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);

  useEffect(() => {
    async function fetchUsage() {
      try {
        const res = await userApi.getUsage();
        if (res.data?.success) {
          setUsageData(res.data.data);
        }
      } catch (err) {
        console.error("Failed to fetch usage data:", err);
      } finally {
        setLoadingUsage(false);
      }
    }
    fetchUsage();
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData(prev => ({
      ...prev,
      [e.target.name]: e.target.value
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      await userApi.updateProfile(formData);
      await updateUser(formData);
      toast.success('Profile updated successfully');
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to update profile');
    } finally {
      setIsSaving(false);
    }
  };

  // Extract initials
  const getInitials = () => {
    if (formData.firstName && formData.lastName) {
      return `${formData.firstName[0]}${formData.lastName[0]}`.toUpperCase();
    }
    if (formData.firstName) return formData.firstName[0].toUpperCase();
    if (formData.username) return formData.username.substring(0, 2).toUpperCase();
    return 'U';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="p-6 md:p-8 max-w-4xl mx-auto space-y-8"
    >
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight text-white">Your Profile</h1>
        <p className="text-gray-400">Manage your personal information and view usage stats.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* Left Column: Form */}
        <div className="md:col-span-2 space-y-6">
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 glass-card">
            <h2 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
              <UserIcon className="w-5 h-5 text-primary" />
              Personal Information
            </h2>
            
            <form onSubmit={handleSave} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-300">First Name</label>
                  <input
                    type="text"
                    name="firstName"
                    value={formData.firstName}
                    onChange={handleChange}
                    className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent transition-all"
                    placeholder="Enter first name"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-300">Last Name</label>
                  <input
                    type="text"
                    name="lastName"
                    value={formData.lastName}
                    onChange={handleChange}
                    className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent transition-all"
                    placeholder="Enter last name"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Username</label>
                <input
                  type="text"
                  name="username"
                  value={formData.username}
                  onChange={handleChange}
                  className="w-full bg-black/20 border border-white/10 rounded-xl px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-transparent transition-all"
                  placeholder="Choose a username"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300 flex items-center justify-between">
                  Email Address
                  <span className="text-xs bg-white/10 text-gray-400 px-2 py-0.5 rounded">Read-only</span>
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <Mail className="h-5 w-5 text-gray-500" />
                  </div>
                  <input
                    type="email"
                    value={user?.email || ''}
                    readOnly
                    className="w-full bg-black/40 border border-white/5 rounded-xl pl-10 px-4 py-2.5 text-gray-400 cursor-not-allowed focus:outline-none"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">Signed in as {user?.email}</p>
              </div>

              <div className="pt-4 border-t border-white/10 flex justify-end">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-6 py-2.5 rounded-xl font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-[#09090B]"
                >
                  {isSaving ? <Activity className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Column: Avatar & Stats */}
        <div className="space-y-6">
          {/* Avatar Card */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 glass-card flex flex-col items-center text-center">
            <div className="relative mb-4 group">
              <div className="w-24 h-24 rounded-full bg-gradient-to-br from-cyan-400 via-primary to-purple-600 p-1">
                <div className="w-full h-full bg-[#09090B] rounded-full flex items-center justify-center">
                  <span className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-br from-white to-gray-400">
                    {getInitials()}
                  </span>
                </div>
              </div>
              <div className="absolute inset-0 bg-black/50 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
                <span className="text-xs font-medium text-white">Change</span>
              </div>
            </div>
            
            <h3 className="text-lg font-semibold text-white">
              {formData.firstName || formData.username ? (
                `${formData.firstName} ${formData.lastName}`.trim() || formData.username
              ) : 'Anonymous User'}
            </h3>
            <p className="text-sm text-gray-400">{user?.role === 'admin' ? 'Administrator' : 'Premium User'}</p>
            
            <div className="mt-6 flex items-center gap-2 justify-center px-4 py-2 bg-primary/10 text-primary border border-primary/20 rounded-lg text-sm font-medium w-full">
              <Shield className="w-4 h-4" />
              Account Active
            </div>
          </div>

          {/* Usage Stats Card */}
          <div className="bg-white/5 border border-white/10 rounded-2xl p-6 glass-card">
            <h3 className="text-lg font-semibold text-white mb-4">Usage Stats</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-black/20 rounded-xl border border-white/5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <MessageSquare className="w-4 h-4 text-blue-400" />
                  </div>
                  <span className="text-sm font-medium text-gray-300">Chats</span>
                </div>
                {loadingUsage ? <SkeletonLoader className="w-8 h-5" /> : (
                  <span className="font-bold text-white">{usageData?.conversationsCount || 0}</span>
                )}
              </div>
              
              <div className="flex items-center justify-between p-3 bg-black/20 rounded-xl border border-white/5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                    <FileText className="w-4 h-4 text-purple-400" />
                  </div>
                  <span className="text-sm font-medium text-gray-300">Docs</span>
                </div>
                {loadingUsage ? <SkeletonLoader className="w-8 h-5" /> : (
                  <span className="font-bold text-white">{usageData?.documentsUploaded || 0}</span>
                )}
              </div>
              
              <div className="flex items-center justify-between p-3 bg-black/20 rounded-xl border border-white/5">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                    <Zap className="w-4 h-4 text-yellow-400" />
                  </div>
                  <span className="text-sm font-medium text-gray-300">Tokens</span>
                </div>
                {loadingUsage ? <SkeletonLoader className="w-12 h-5" /> : (
                  <span className="font-bold text-white">
                    {(usageData?.tokensUsed || 0).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
        
      </div>
    </motion.div>
  );
}