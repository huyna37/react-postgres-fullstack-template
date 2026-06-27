# Stage 1: Build the React frontend
FROM node:20 AS frontend-builder
WORKDIR /app/client

# Copy package files and install dependencies
COPY client/package*.json ./
RUN npm install -f

# Copy source code and build
COPY client/ ./
RUN npm run build

# Stage 2: Build the Express backend and include runtime SDKs
FROM node:20
WORKDIR /app/server

# Install system dependencies and .NET 8 SDK
RUN apt-get update && apt-get install -y \
    wget \
    gpg \
    jq \
    ripgrep \
    git \
    && wget https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -O packages-microsoft-prod.deb \
    && dpkg -i packages-microsoft-prod.deb \
    && rm packages-microsoft-prod.deb \
    && apt-get update && apt-get install -y \
    dotnet-sdk-8.0 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Angular CLI globally
RUN npm install -g @angular/cli

# Copy package files and install dependencies
COPY server/package*.json ./
RUN npm install --production

# Copy backend source code
COPY server/ ./

# Copy .env file to the root of the app (/app/.env)
COPY .env ../.env

# Copy built frontend files from Stage 1
COPY --from=frontend-builder /app/client/dist /app/client/dist

# Set production environment
ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

# Start the server
CMD ["node", "index.js"]
