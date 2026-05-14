#!/bin/bash

# KFive AI - Development Environment Setup
# Sets up the development environment with hot reloading

set -e

echo "🔧 KFive AI - Development Setup"
echo "==============================="

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

# Check if services are running
check_services() {
    print_status "Checking required services..."
    
    # Check MongoDB
    if ! curl -s http://localhost:27017 > /dev/null 2>&1; then
        print_warning "MongoDB is not running on port 27017"
        echo "  Start with: docker run -d -p 27017:27017 mongo:7.0"
    else
        print_success "MongoDB is running"
    fi
    
    # Check Redis
    if ! redis-cli ping > /dev/null 2>&1; then
        print_warning "Redis is not running on port 6379"
        echo "  Start with: docker run -d -p 6379:6379 redis:7.2-alpine"
    else
        print_success "Redis is running"
    fi
    
    # Check Ollama
    if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
        print_warning "Ollama is not running on port 11434"
        echo "  Start with: ollama serve"
    else
        print_success "Ollama is running"
    fi
}

# Setup development databases
setup_dev_db() {
    print_status "Setting up development database..."
    
    # Create .env files if they don't exist
    if [ ! -f "backend/.env" ]; then
        cp backend/.env.example backend/.env
        print_success "Created backend/.env"
    fi
    
    if [ ! -f "frontend/.env" ]; then
        cp frontend/.env.example frontend/.env
        print_success "Created frontend/.env"
    fi
}

# Install development tools
install_dev_tools() {
    print_status "Installing development tools..."
    
    # Install global tools if not present
    if ! command -v nodemon &> /dev/null; then
        npm install -g nodemon
        print_success "Installed nodemon"
    fi
    
    if ! command -v concurrently &> /dev/null; then
        npm install -g concurrently
        print_success "Installed concurrently"
    fi
}

# Setup Git hooks
setup_git_hooks() {
    print_status "Setting up Git hooks..."
    
    # Create pre-commit hook
    cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
echo "Running pre-commit checks..."

# Run linting
npm run lint:frontend
npm run lint:backend

# Run type checking
cd frontend && npm run build && cd ..
cd backend && npm run build && cd ..

echo "Pre-commit checks passed!"
EOF

    chmod +x .git/hooks/pre-commit
    print_success "Git hooks configured"
}

# Main function
main() {
    echo
    print_status "Setting up KFive AI development environment..."
    echo
    
    # Check services
    check_services
    
    echo
    
    # Setup development database
    setup_dev_db
    
    # Install development tools
    install_dev_tools
    
    # Setup Git hooks
    if [ -d ".git" ]; then
        setup_git_hooks
    fi
    
    echo
    print_success "🎉 Development environment is ready!"
    echo
    echo "🚀 Quick start commands:"
    echo "  npm run dev          # Start both frontend and backend"
    echo "  npm run dev:frontend # Start only frontend"
    echo "  npm run dev:backend  # Start only backend"
    echo "  npm run docker:up    # Start with Docker"
    echo
    echo "🔧 Development URLs:"
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:5000"
    echo "  API Docs: http://localhost:5000/api/v1/docs"
    echo
    echo "📊 Monitoring:"
    echo "  MongoDB: mongodb://localhost:27017"
    echo "  Redis:   redis://localhost:6379"
    echo "  Ollama:  http://localhost:11434"
    echo
}

# Run main function
main "$@"