#!/bin/bash

# KFive AI - Ollama Model Setup Script
# Downloads and configures all required Ollama models

set -e

echo "🤖 KFive AI - Ollama Model Setup"
echo "================================"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

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

# Check if Ollama is running
check_ollama_running() {
    if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        print_error "Ollama is not running. Please start Ollama first:"
        echo "  ollama serve"
        exit 1
    fi
    print_success "Ollama is running"
}

# Pull a model with progress
pull_model() {
    local model=$1
    local description=$2
    
    print_status "Pulling $model ($description)..."
    
    if ollama pull "$model"; then
        print_success "✅ $model downloaded successfully"
    else
        print_error "❌ Failed to download $model"
        return 1
    fi
}

# Main function
main() {
    echo
    print_status "Setting up Ollama models for KFive AI..."
    echo
    
    # Check if Ollama is running
    check_ollama_running
    
    echo
    print_status "Downloading AI models (this may take a while)..."
    echo
    
    # Core models for KFive AI
    pull_model "llama3" "Main conversational AI model"
    pull_model "deepseek-coder" "Code generation and analysis"
    pull_model "llava" "Vision and image understanding"
    pull_model "nomic-embed-text" "Text embeddings for RAG"
    pull_model "whisper" "Speech-to-text processing"
    
    echo
    print_status "Verifying model installation..."
    
    # List installed models
    echo
    print_status "Installed models:"
    ollama list
    
    echo
    print_success "🎉 All KFive AI models are ready!"
    echo
    echo "📋 Model Usage:"
    echo "  • llama3: Main chat and reasoning"
    echo "  • deepseek-coder: Code generation and debugging"
    echo "  • llava: Image analysis and vision tasks"
    echo "  • nomic-embed-text: Document embeddings"
    echo "  • whisper: Voice-to-text conversion"
    echo
    echo "🚀 You can now start KFive AI:"
    echo "  npm run dev"
    echo
}

# Run main function
main "$@"