#!/bin/bash

# KFive AI - Setup Script
# This script sets up the complete KFive AI development environment

set -e

echo "🚀 Setting up KFive AI - Offline Agentic AI Workspace Platform"
echo "================================================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if Node.js is installed
check_node() {
    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed. Please install Node.js 18+ and try again."
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js version 18+ is required. Current version: $(node -v)"
        exit 1
    fi
    
    print_success "Node.js $(node -v) is installed"
}

# Check if Docker is installed
check_docker() {
    if ! command -v docker &> /dev/null; then
        print_warning "Docker is not installed. You'll need Docker to run the full stack."
        print_warning "Install Docker from: https://docs.docker.com/get-docker/"
        return 1
    fi
    
    if ! command -v docker-compose &> /dev/null; then
        print_warning "Docker Compose is not installed."
        return 1
    fi
    
    print_success "Docker and Docker Compose are installed"
    return 0
}

# Check if Ollama is installed
check_ollama() {
    if ! command -v ollama &> /dev/null; then
        print_warning "Ollama is not installed. Installing Ollama..."
        
        # Install Ollama
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            curl -fsSL https://ollama.ai/install.sh | sh
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            print_warning "Please install Ollama manually from: https://ollama.ai/download"
            return 1
        else
            print_warning "Please install Ollama manually from: https://ollama.ai/download"
            return 1
        fi
    fi
    
    print_success "Ollama is installed"
    return 0
}

# Install dependencies
install_dependencies() {
    print_status "Installing project dependencies..."
    
    # Root dependencies
    npm install
    
    # Frontend dependencies
    print_status "Installing frontend dependencies..."
    cd frontend && npm install && cd ..
    
    # Backend dependencies
    print_status "Installing backend dependencies..."
    cd backend && npm install && cd ..
    
    print_success "All dependencies installed"
}

# Setup environment files
setup_env_files() {
    print_status "Setting up environment files..."
    
    # Backend environment
    if [ ! -f "backend/.env" ]; then
        cp backend/.env.example backend/.env
        print_success "Created backend/.env from example"
    else
        print_warning "backend/.env already exists, skipping..."
    fi
    
    # Frontend environment
    if [ ! -f "frontend/.env" ]; then
        cp frontend/.env.example frontend/.env
        print_success "Created frontend/.env from example"
    else
        print_warning "frontend/.env already exists, skipping..."
    fi
}

# Pull Ollama models
pull_ollama_models() {
    print_status "Pulling required Ollama models..."
    
    models=("llama3" "deepseek-coder" "llava" "nomic-embed-text" "whisper")
    
    for model in "${models[@]}"; do
        print_status "Pulling $model..."
        if ollama pull "$model"; then
            print_success "Successfully pulled $model"
        else
            print_error "Failed to pull $model"
        fi
    done
}

# Create necessary directories
create_directories() {
    print_status "Creating necessary directories..."
    
    mkdir -p backend/uploads
    mkdir -p backend/logs
    mkdir -p frontend/public
    
    print_success "Directories created"
}

# Main setup function
main() {
    echo
    print_status "Starting KFive AI setup..."
    echo
    
    # Check prerequisites
    check_node
    DOCKER_AVAILABLE=$(check_docker && echo "true" || echo "false")
    OLLAMA_AVAILABLE=$(check_ollama && echo "true" || echo "false")
    
    echo
    
    # Install dependencies
    install_dependencies
    
    # Setup environment files
    setup_env_files
    
    # Create directories
    create_directories
    
    # Pull Ollama models if available
    if [ "$OLLAMA_AVAILABLE" = "true" ]; then
        echo
        read -p "Do you want to pull Ollama models now? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            pull_ollama_models
        else
            print_warning "Skipping Ollama model download. You can run 'npm run ollama:setup' later."
        fi
    fi
    
    echo
    print_success "KFive AI setup completed!"
    echo
    echo "🎉 Next steps:"
    echo "1. Start Ollama: ollama serve"
    echo "2. Start development servers: npm run dev"
    echo "3. Or start with Docker: npm run docker:up"
    echo
    echo "📚 Documentation:"
    echo "- Frontend: http://localhost:3000"
    echo "- Backend API: http://localhost:5000/api/v1"
    echo "- README.md for detailed instructions"
    echo
    echo "🤖 Happy coding with KFive AI!"
}

# Run main function
main "$@"