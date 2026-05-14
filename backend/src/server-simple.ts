import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

console.log('Starting KFive AI Backend on port:', process.env.PORT || 5001);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  }
});

const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-refresh-token']
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// Body parsing middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  });
});

// API health check
app.get('/api/v1/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: 'v1',
    uptime: process.uptime()
  });
});

// Simple test routes
app.get('/api/v1/test', (req, res) => {
  res.json({
    success: true,
    message: 'KFive AI Backend is running!',
    timestamp: new Date().toISOString()
  });
});

// Auth routes
app.post('/api/v1/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  // Simple mock authentication
  if (email && password) {
    const mockUser = {
      _id: '1',
      email: email,
      username: email.split('@')[0],
      firstName: 'Demo',
      lastName: 'User',
      role: 'user',
      preferences: {
        theme: 'dark',
        language: 'en',
        ai: {
          defaultModel: 'llama3',
          voiceEnabled: true
        }
      }
    };
    
    const mockTokens = {
      accessToken: 'mock-access-token-' + Date.now(),
      refreshToken: 'mock-refresh-token-' + Date.now()
    };
    
    res.json({
      success: true,
      data: {
        user: mockUser,
        ...mockTokens
      }
    });
  } else {
    res.status(400).json({
      success: false,
      error: { message: 'Email and password are required' }
    });
  }
});

app.post('/api/v1/auth/register', (req, res) => {
  const { email, username, password, firstName, lastName } = req.body;
  
  if (email && username && password) {
    const mockUser = {
      _id: '1',
      email,
      username,
      firstName: firstName || 'New',
      lastName: lastName || 'User',
      role: 'user',
      preferences: {
        theme: 'dark',
        language: 'en',
        ai: {
          defaultModel: 'llama3',
          voiceEnabled: true
        }
      }
    };
    
    const mockTokens = {
      accessToken: 'mock-access-token-' + Date.now(),
      refreshToken: 'mock-refresh-token-' + Date.now()
    };
    
    res.json({
      success: true,
      data: {
        user: mockUser,
        ...mockTokens
      }
    });
  } else {
    res.status(400).json({
      success: false,
      error: { message: 'Email, username, and password are required' }
    });
  }
});

app.post('/api/v1/auth/refresh', (req, res) => {
  const { refreshToken } = req.body;
  
  if (refreshToken) {
    res.json({
      success: true,
      data: {
        accessToken: 'mock-access-token-' + Date.now(),
        refreshToken: 'mock-refresh-token-' + Date.now()
      }
    });
  } else {
    res.status(401).json({
      success: false,
      error: { message: 'Invalid refresh token' }
    });
  }
});

app.post('/api/v1/auth/logout', (req, res) => {
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
  
  socket.emit('welcome', { message: 'Connected to KFive AI' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl
  });
});

// Error handling middleware
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('API Error:', error);
  res.status(500).json({
    success: false,
    error: {
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    },
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 KFive AI Backend running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 API URL: http://localhost:${PORT}/api/v1`);
  console.log(`🔌 WebSocket URL: ws://localhost:${PORT}`);
});

export { app, io };