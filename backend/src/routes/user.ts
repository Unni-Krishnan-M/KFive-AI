import { Router } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { User } from '@/models/User';
import { AppError } from '@/middleware/errorHandler';

const router = Router();

// Get user profile
router.get('/profile', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  res.json({ success: true, data: user });
}));

// Update user profile
router.put('/profile', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const updates = req.body;
  
  // Exclude sensitive fields
  delete updates.password;
  delete updates.role;
  delete updates.email;

  const user = await User.findByIdAndUpdate(userId, updates, { new: true, runValidators: true });
  if (!user) throw new AppError('User not found', 404);
  
  res.json({ success: true, data: user });
}));

// Get user usage stats
router.get('/usage', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);
  
  res.json({ success: true, data: user.usage });
}));

// Get recent activity across app
router.get('/activity', asyncHandler(async (req, res) => {
  const userId = (req as any).user?.userId || 'default-user-id';
  
  // To resolve dependencies safely without cyclical issues inside a single prompt,
  // we query mongoose collections generically or use direct imports.
  const mongoose = require('mongoose');

  let activities: any[] = [];

  try {
    const Chat = mongoose.model('Conversation');
    const recentChats = await Chat.find({ userId }).sort({ updatedAt: -1 }).limit(5);
    recentChats.forEach((c: any) => activities.push({
      id: c._id, title: 'Chat: ' + c.title, time: c.updatedAt, icon: 'message'
    }));
  } catch(e) {}

  try {
     const Doc = mongoose.model('Document');
     const recentDocs = await Doc.find({ userId }).sort({ createdAt: -1 }).limit(5);
     recentDocs.forEach((d: any) => activities.push({
       id: d._id, title: 'Document: ' + d.originalName, time: d.createdAt, icon: 'document'
     }));
  } catch(e) {}

  try {
     const Agent = mongoose.model('Agent');
     const agents = await Agent.find({ userId }).sort({ createdAt: -1 }).limit(2);
     agents.forEach((a: any) => activities.push({
       id: a._id, title: 'Agent Created: ' + a.name, time: a.createdAt, icon: 'agent'
     }));
  } catch(e) {}

  // Sort unified activities directly
  activities.sort((a,b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  
  res.json({ success: true, data: activities.slice(0, 8) });
}));

export default router;