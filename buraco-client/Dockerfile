FROM node:20-alpine

# The app is pulled from git at runtime by the entrypoint; the image itself
# carries no app code. Rebuild this image only when the Dockerfile or
# deploy/entrypoint.sh changes, not for app updates.
RUN apk add --no-cache git

WORKDIR /app
COPY deploy/entrypoint.sh /usr/local/bin/git-entrypoint.sh
RUN chmod +x /usr/local/bin/git-entrypoint.sh

EXPOSE 5173
ENTRYPOINT ["/usr/local/bin/git-entrypoint.sh"]
