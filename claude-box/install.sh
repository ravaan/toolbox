#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== claude-box installer ==="
echo ""

# Check Docker is available
if ! command -v docker &>/dev/null; then
    echo "Error: Docker is not installed. Please install Docker Desktop first."
    exit 1
fi

if ! docker info &>/dev/null; then
    echo "Error: Docker Desktop is not running. Please start it and try again."
    exit 1
fi

# Build the Docker image
# Use cygpath to convert to Windows path for Docker Desktop
echo "Building claude-box Docker image (this takes a few minutes)..."
BUILD_DIR="$SCRIPT_DIR"
if command -v cygpath &>/dev/null; then
    BUILD_DIR="$(cygpath -w "$SCRIPT_DIR")"
fi
docker build \
    --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -t claude-box:latest "$BUILD_DIR"

echo ""

# Install the CLI script to ~/.local/bin (already in PATH)
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/claude-box" "$INSTALL_DIR/claude-box"
cp "$SCRIPT_DIR/claude-box.cmd" "$INSTALL_DIR/claude-box.cmd"
sed -i 's/\r$//' "$INSTALL_DIR/claude-box"
chmod +x "$INSTALL_DIR/claude-box"

echo "Installed 'claude-box' to $INSTALL_DIR/claude-box"

# Verify it's in PATH
if command -v claude-box &>/dev/null; then
    echo ""
    echo "=== Installation complete ==="
    echo ""
    echo "Usage:"
    echo "  cd ~/Documents/dev/your-project"
    echo "  claude-box                    # Launch Claude Code in Docker"
    echo "  claude-box new my-app         # Create new project + launch"
    echo "  claude-box help               # See all commands"
else
    echo ""
    echo "WARNING: $INSTALL_DIR is not in your PATH."
    echo "Add this to your ~/.bashrc:"
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
    echo ""
    echo "Then restart your terminal and run 'claude-box'."
fi
