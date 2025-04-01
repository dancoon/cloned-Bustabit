FROM node:14

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application code
COPY . .

# Create necessary directories if they don't exist
RUN mkdir -p logs config

EXPOSE 5432

# Start the game module
CMD ["npm", "start"]