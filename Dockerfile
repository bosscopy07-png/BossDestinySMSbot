FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --only=production

# Force cache bust - copy source LAST
COPY . .

# Verify files exist
RUN ls -la app.js || (echo "ERROR: app.js not found" && exit 1)

# Create logs directory
RUN mkdir -p logs

EXPOSE 3000

CMD ["node", "app.js"]
