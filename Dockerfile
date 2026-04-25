FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy ALL source code
COPY . .

# Verify structure (debug - check what actually exists)
RUN ls -la && echo "---" && ls -la *.js 2>/dev/null || echo "No .js files in root"

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "app.js"]
