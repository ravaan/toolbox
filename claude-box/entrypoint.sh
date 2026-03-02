#!/bin/bash
set -e

HOME_DIR="$HOME"

# --- SSH Keys ---
# Windows NTFS mounts keys as 644; Linux SSH rejects anything > 600.
# We copy from a staging mount (/mnt/ssh-host) and fix permissions.
if [ -d /mnt/ssh-host ]; then
    mkdir -p "$HOME_DIR/.ssh"
    for f in /mnt/ssh-host/id_* /mnt/ssh-host/known_hosts /mnt/ssh-host/config; do
        [ -f "$f" ] && cp "$f" "$HOME_DIR/.ssh/"
    done
    chmod 700 "$HOME_DIR/.ssh"
    chmod 600 "$HOME_DIR/.ssh"/id_* 2>/dev/null || true
    chmod 644 "$HOME_DIR/.ssh"/*.pub "$HOME_DIR/.ssh"/known_hosts "$HOME_DIR/.ssh"/config 2>/dev/null || true
fi

# --- Git Config ---
# Extract ONLY name + email from host gitconfig.
# Don't mount the full file — it may contain Windows credential helpers,
# gpg program paths, or autocrlf=true, all incompatible in Linux.
if [ -f /mnt/gitconfig-host ]; then
    name=$(git config -f /mnt/gitconfig-host user.name 2>/dev/null || true)
    email=$(git config -f /mnt/gitconfig-host user.email 2>/dev/null || true)
    [ -n "$name" ] && git config --global user.name "$name"
    [ -n "$email" ] && git config --global user.email "$email"
fi
git config --global core.autocrlf input
git config --global safe.directory /workspace

# --- Claude Code Config ---
# .claude.json holds app state (login account, preferences).
# Mounted read-only to staging path; copied so Claude Code can do atomic writes.
if [ -f /mnt/claude-config-host ]; then
    cp /mnt/claude-config-host "$HOME_DIR/.claude.json"
fi

# --- Keep container alive ---
exec sleep infinity
