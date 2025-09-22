# Stage 1: Build the React client
FROM node:20-alpine AS client-builder

# Set the working directory for the client
WORKDIR /app/client

# Copy client package files and install dependencies
COPY client/package.json client/package-lock.json* ./
RUN npm install

# Copy the rest of the client source code
COPY client/ ./

# Build the React app
RUN npm run build

# Stage 2: Setup the Node.js server
FROM node:20-alpine AS server

WORKDIR /app

# Copy server package files and install production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the server source code
COPY . .

# Copy the entrypoint script
COPY entrypoint.sh .

# Make the entrypoint script executable
RUN chmod +x entrypoint.sh

# Copy the built React app from the client-builder stage
COPY --from=client-builder /app/client/dist ./public

# Expose the port the server runs on
EXPOSE 3000

# Set the entrypoint script to run on container start
ENTRYPOINT [ "./entrypoint.sh" ]

# The default command to start the server, passed to the entrypoint
CMD [ "node", "index.js" ]