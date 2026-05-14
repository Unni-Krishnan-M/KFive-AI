# KFive AI - Offline Agentic AI Workspace Platform

> A futuristic local-first AI operating system powered entirely by Ollama with memory, agents, voice, workspace automation, and mobile support.

## 🚀 Project Overview

KFive AI is a production-level AI platform that goes beyond traditional chatbots to create an AI-powered operating system experience. Built with modern full-stack technologies and powered by local Ollama models, it provides a completely offline AI workspace with advanced features like multi-agent systems, persistent memory, voice interaction, and real-time collaboration.

## ✨ Key Features

- 🤖 **Multi-Agent AI System** - Specialized agents for coding, research, debugging, and productivity
- 🧠 **Persistent AI Memory** - Remembers users, projects, preferences, and conversation history
- 🎤 **Voice AI Assistant** - Two-way voice conversations with local Whisper STT and TTS
- 📱 **Mobile Companion** - Progressive Web App with full mobile synchronization
- 🔒 **Offline-First** - Complete functionality without internet using local Ollama models
- 🏢 **AI Workspace** - Virtual environments for coding, research, and project management
- 📄 **Document AI** - Upload and analyze PDFs, images, and documents with RAG
- 💻 **Code Generation** - Generate full applications, APIs, and project scaffolds
- 🎨 **Futuristic UI** - Glassmorphism design with smooth animations and AI interactions
- ⚡ **Real-time Streaming** - Live AI responses with WebSocket communication

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │    Backend      │    │   AI Engine     │
│   React + TS    │◄──►│   Node.js       │◄──►│    Ollama       │
│   Vite + PWA    │    │   Express       │    │   Local LLMs    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │              ┌─────────────────┐              │
         │              │   Databases     │              │
         └──────────────►│   MongoDB       │◄─────────────┘
                        │   Redis         │
                        │   ChromaDB      │
                        └─────────────────┘
```

## 🛠️ Tech Stack

### Frontend
- **Framework**: React 18 + TypeScript + Vite
- **Styling**: TailwindCSS + Framer Motion + shadcn/ui
- **State**: Zustand + React Query
- **Real-time**: Socket.IO Client
- **Voice**: Web Speech API + Whisper
- **Mobile**: Progressive Web App

### Backend
- **Runtime**: Node.js + Express.js + TypeScript
- **Real-time**: Socket.IO
- **Authentication**: JWT + Refresh Tokens
- **Queue**: BullMQ + Redis
- **AI**: Ollama + LangChain + LangGraph

### Databases
- **Primary**: MongoDB (User data, conversations)
- **Cache**: Redis (Sessions, real-time data)
- **Vector**: ChromaDB (Embeddings, RAG)

### AI Models (Ollama)
- **Chat**: Llama 3 (Main conversational AI)
- **Code**: DeepSeek Coder (Code generation)
- **Vision**: LLaVA (Image understanding)
- **Embeddings**: Nomic Embed Text (RAG)
- **Speech**: Whisper (Speech-to-text)

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Ollama installed locally

### 1. Clone and Install
```bash
git clone https://github.com/yourusername/kfive-ai.git
cd kfive-ai
npm run install:all
```

### 2. Setup Ollama Models
```bash
# Install required models
ollama pull llama3
ollama pull deepseek-coder
ollama pull llava
ollama pull nomic-embed-text
ollama pull whisper
```

### 3. Environment Setup
```bash
# Copy environment files
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env

# Edit with your configurations
```

### 4. Start with Docker
```bash
# Start all services
npm run docker:up

# Or start development servers
npm run dev
```

### 5. Access the Application
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:5000
- **MongoDB**: localhost:27017
- **Redis**: localhost:6379
- **ChromaDB**: http://localhost:8000

## 📱 Mobile Setup

The mobile app is built as a Progressive Web App (PWA) that can be installed on any device:

1. Open http://localhost:3000 on your mobile browser
2. Tap "Add to Home Screen" when prompted
3. The app will install and sync with your desktop workspace

## 🤖 AI Agents

KFive AI includes specialized agents for different tasks:

- **Code Architect**: Builds full-stack applications and APIs
- **Research Analyst**: Searches and summarizes technical topics
- **Bug Hunter**: Debugs code and explains errors
- **Career Mentor**: Improves resumes and interview skills
- **Productivity AI**: Manages tasks and schedules
- **Voice Assistant**: Handles voice interactions and commands

## 📊 Features Showcase

### Real-time AI Chat
- Streaming responses with typing effects
- Markdown rendering with code highlighting
- Image uploads and analysis
- Conversation memory and context

### AI Memory System
- Persistent user preferences and habits
- Project and goal tracking
- Conversation history with semantic search
- Smart context retrieval

### Voice AI
- Natural voice conversations
- Wake word detection
- Real-time speech processing
- Voice command execution

### Document AI
- PDF, DOCX, PPT processing
- Image OCR and analysis
- Semantic search across documents
- Citation and source tracking

## 🔧 Development

### Project Structure
```
kfive-ai/
├── frontend/          # React TypeScript frontend
├── backend/           # Node.js Express backend
├── mobile/            # React Native Expo (optional)
├── docker-compose.yml # Docker services
└── README.md
```

### Available Scripts
```bash
npm run dev              # Start development servers
npm run build            # Build for production
npm run test             # Run all tests
npm run docker:up        # Start Docker services
npm run docker:down      # Stop Docker services
```

## 🚀 Deployment

### Production Deployment
1. **Frontend**: Deploy to Vercel/Netlify
2. **Backend**: Deploy to Railway/Render/AWS
3. **Database**: MongoDB Atlas + Redis Cloud
4. **AI**: Self-hosted Ollama or cloud GPU

### Docker Production
```bash
# Build and deploy with Docker
docker-compose -f docker-compose.prod.yml up -d
```

## 🎯 Resume Highlights

This project demonstrates:
- **Advanced AI Engineering**: Local LLM integration, RAG pipelines, multi-agent systems
- **Full-Stack Architecture**: React, Node.js, MongoDB, real-time WebSockets
- **Modern DevOps**: Docker, CI/CD, scalable deployment
- **Mobile Development**: PWA, cross-platform compatibility
- **System Design**: Microservice-ready architecture, scalable patterns
- **Security**: JWT authentication, input validation, secure file handling

## 🔮 Future Roadmap

- [ ] AI Video Generation
- [ ] Browser Automation Agent
- [ ] Computer Control Agent
- [ ] AI Plugin Marketplace
- [ ] 3D Avatar Assistant
- [ ] Knowledge Graph Visualization
- [ ] Self-Improving Agents

## 📄 License

MIT License - see LICENSE file for details

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

---

**Built with ❤️ for the future of AI-powered productivity**