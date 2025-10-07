# Use an official Node.js runtime as a base image
FROM node:20.11.1-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies including dev dependencies
RUN npm install

# Generate Prisma Client (but don't run migrations yet)
RUN npx prisma generate

# Expose the port your app runs on
EXPOSE 3000

# Use nodemon for hot-reloading in development
CMD ["npm", "run", "start:dev"]