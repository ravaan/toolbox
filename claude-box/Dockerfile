FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Single layer: all tools installed, caches cleaned
# - Node.js 22 LTS for JS/TS projects
# - Python 3 for Python projects
# - build-essential for native npm addons
# - tini for proper PID 1 (signal forwarding + zombie reaping)
# - dos2unix to fix Windows CRLF in copied scripts
# - Claude Code CLI for AI-assisted development
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates curl git jq unzip openssh-client \
      python3 python3-pip python3-venv \
      build-essential dos2unix tini && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    npm cache clean --force && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# Build metadata for staleness detection
ARG BUILD_DATE=unknown
LABEL claude-box.built-at="$BUILD_DATE" \
      com.claude-box="true"

# Create non-root user (Claude Code refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude && \
    mkdir -p /workspace && \
    chown claude:claude /workspace

WORKDIR /workspace

# Copy and fix entrypoint (dos2unix prevents CRLF breakage from Windows editors)
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN dos2unix /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

USER claude
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
