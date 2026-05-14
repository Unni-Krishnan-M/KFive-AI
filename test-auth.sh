#!/bin/bash

echo "🧪 Testing KFive AI Authentication System"
echo "=========================================="

# Test login endpoint
echo "📝 Testing login..."
LOGIN_RESPONSE=$(curl -s -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"password123"}')

echo "Login Response:"
echo $LOGIN_RESPONSE | jq '.' 2>/dev/null || echo $LOGIN_RESPONSE

echo ""

# Test registration endpoint
echo "📝 Testing registration..."
REGISTER_RESPONSE=$(curl -s -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"newuser@example.com","username":"newuser","password":"password123","firstName":"New","lastName":"User"}')

echo "Register Response:"
echo $REGISTER_RESPONSE | jq '.' 2>/dev/null || echo $REGISTER_RESPONSE

echo ""

# Test health endpoint
echo "📝 Testing health endpoint..."
HEALTH_RESPONSE=$(curl -s http://localhost:3001/api/v1/health)

echo "Health Response:"
echo $HEALTH_RESPONSE | jq '.' 2>/dev/null || echo $HEALTH_RESPONSE

echo ""
echo "✅ Authentication tests completed!"