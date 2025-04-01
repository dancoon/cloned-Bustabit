# Use a stable Node.js version
FROM node:18

# Set the working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./

RUN npm install --omit=dev

# Copy the rest of the application
COPY . .

# Copy environment variables
COPY .env .env

# Expose the application port
EXPOSE 3841

# Start the application
CMD ["npm", "start"]
