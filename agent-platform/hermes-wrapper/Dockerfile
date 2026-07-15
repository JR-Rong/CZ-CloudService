ARG HERMES_BASE_IMAGE=node:22-alpine
FROM ${HERMES_BASE_IMAGE}

COPY hermes-profilectl.js /usr/local/bin/hermes-profilectl
RUN chmod 0755 /usr/local/bin/hermes-profilectl

VOLUME ["/data"]
CMD ["sh", "-c", "while true; do sleep 3600; done"]
