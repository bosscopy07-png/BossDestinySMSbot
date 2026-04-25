FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy ALL source code (including src/)
COPY . .

# Verify src exists (debug)
RUN ls -la src/ || echo "WARNING: src/ not found"

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "app.js"]
