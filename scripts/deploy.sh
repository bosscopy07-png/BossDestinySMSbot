#!/bin/bash

# Production Deployment Script

set -e

echo "🚀 Starting deployment..."

# Pull latest code
git pull origin main

# Install dependencies
echo "📦 Installing dependencies..."
npm ci --only=production

# Run tests
echo "🧪 Running tests..."
npm test

# Build (if needed)
echo "🔨 Building..."
# npm run build

# Restart services
echo "🔄 Restarting services..."
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d --build

# Health check
echo "🏥 Health check..."
sleep 5
curl -f http://localhost:3000/health || exit 1

echo "✅ Deployment completed successfully!"
