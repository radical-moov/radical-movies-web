# Build the static bundle, then serve it with nginx.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json build.mjs ./
COPY src ./src
# FOOTER_URL can be overridden at build time for other environments.
ARG FOOTER_URL=https://theradicalparty.com/footer.js
ENV FOOTER_URL=$FOOTER_URL
RUN node build.mjs

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
