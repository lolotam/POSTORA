# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
# Source maps are uploaded to Sentry during the build (see vite.config.ts); whatever is
# left must not ship, or the unminified source is one URL away on postora.cloud.
RUN npm run build && find dist -name '*.map' -type f -delete

# Stage 2: Serve
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
