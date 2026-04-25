FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --only=production

# Copy ALL source code
COPY . .

# Verify structure
RUN ls -la

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "app.js"]
