# claude-box

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) inside Docker with `--dangerously-skip-permissions` — safely.

Claude Code's full-auto mode (`--dangerously-skip-permissions`) lets it run shell commands, edit files, and install packages without asking. That's powerful, but risky on a bare host. claude-box wraps it in a Docker container so Claude gets full autonomy inside a sandboxed Linux environment while your host stays untouched.

## Why

- **Safety** — Claude Code with `--dangerously-skip-permissions` can `rm -rf`, install random packages, or run arbitrary commands. Inside a container, the blast radius is limited. Your host filesystem is only exposed via the project directory bind mount.
- **Reproducibility** — Every container starts from the same Ubuntu 24.04 image with Node.js 22, Python 3, and build-essential. No "works on my machine" issues.
- **Parallel projects** — Run multiple containers simultaneously, each with its own isolated environment and automatically-mapped ports.
- **Windows-friendly** — Built for Docker Desktop on Windows. Works from PowerShell, CMD, and Git Bash with full path handling for MSYS/cygpath quirks.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running)
- [Git for Windows](https://gitforwindows.org/) (provides Git Bash, required for the CLI)
- An active [Claude Code](https://docs.anthropic.com/en/docs/claude-code) login on your host (`claude login`)

## Install

```bash
git clone <this-repo>
cd claude-box
bash install.sh
```

This will:
1. Build the `claude-box:latest` Docker image (~5 min first time)
2. Copy the `claude-box` CLI to `~/.local/bin/`

If `~/.local/bin` is not in your PATH, add it:
```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Quick Start

```bash
# Launch Claude Code for an existing project
cd ~/Documents/dev/my-project
claude-box

# Create a new project and launch
claude-box new my-new-app
```

That's it. Claude Code starts inside Docker with full permissions. Your project files are bind-mounted — edits are instant and bidirectional.

## Commands

| Command | Description |
|---|---|
| `claude-box` | Launch Claude Code for the current directory |
| `claude-box new <name>` | Create `~/Documents/dev/<name>` and launch |
| `claude-box shell` | Open a bash shell in the current project's container |
| `claude-box stop [name]` | Stop a running container (defaults to current dir) |
| `claude-box rm [name]` | Remove a container (with confirmation prompt) |
| `claude-box ls` | List all claude-box containers and their status |
| `claude-box build` | Rebuild the Docker image (updates Claude Code CLI) |
| `claude-box clean` | Remove all stopped claude-box containers |
| `claude-box help` | Show help |

## How It Works

### Container Lifecycle

Containers are **long-lived**. The first `claude-box` in a directory creates a container; subsequent runs reattach to it. Tools you `apt-get install` or `npm install -g` inside the container persist across sessions. Only `claude-box rm` or `claude-box clean` removes them.

Each project directory gets its own container, named `claude-box-{dirname}-{hash}` (the hash prevents collisions between identically-named directories at different paths).

### What Gets Mounted

| Host | Container | Mode | Notes |
|---|---|---|---|
| Project directory | `/workspace` | read-write | Bidirectional file sync |
| `~/.claude/` | `/home/claude/.claude/` | read-write | Claude Code settings, credentials, session history |
| `~/.claude.json` | `/mnt/claude-config-host` | read-only | Copied to `~/.claude.json` on startup (login state) |
| `~/.ssh/` | `/mnt/ssh-host` | read-only | Copied + permissions fixed on startup |
| `~/.gitconfig` | `/mnt/gitconfig-host` | read-only | Only `user.name` and `user.email` are extracted |

**Why staging mounts for some files?** SSH keys need `chmod 600` which can't be done on NTFS bind mounts. `.claude.json` and `.gitconfig` use atomic writes (write-tmp + rename) which would disconnect direct single-file bind mounts. The entrypoint copies these from staging paths and fixes permissions on startup.

### Port Mapping

claude-box scans your project for port numbers and automatically maps them:

- `.env` / `.env.local` — `PORT=3000`
- `vite.config.*` — `port: 5173`
- `vite.config.*` proxy targets — `localhost:4000`
- `package.json` scripts — `--port 8080`

If a port is already in use on the host (e.g., another container), it increments until it finds a free one:

```
Detected project ports: 3000 5173
  Port 3000 -> host:3000
  Port 5173 -> host:5174 (original in use)
```

If no ports are detected, defaults to 3000, 5173, and 8080.

### Security Model

The container runs with hardened defaults:

- **Non-root user** — Claude Code runs as user `claude` (it refuses `--dangerously-skip-permissions` as root)
- **Dropped capabilities** — `--cap-drop=ALL` with only `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE` added back
- **No privilege escalation** — `--security-opt=no-new-privileges`
- **Resource limits** — 8 GB RAM, 4 CPUs, 512 PIDs
- **Localhost-only ports** — All port mappings bind to `127.0.0.1`
- **Full network access** — The container can reach the internet (needed for `npm install`, `git clone`, API calls, etc.)

> **Important:** This is a convenience sandbox, not a security boundary. Docker containers share the host kernel. The bind-mounted project directory is fully writable. This is better than running `--dangerously-skip-permissions` on bare metal, but don't treat it as a hardened jail.

### Authentication

claude-box shares your host's Claude Code login. No need to re-authenticate inside the container. It mounts:

- `~/.claude/` — OAuth credentials and session data
- `~/.claude.json` — App state with account info (copied on startup)

Alternatively, set `ANTHROPIC_API_KEY` as an environment variable and it will be passed into the container.

## Image Included

The Docker image ships with:

- Ubuntu 24.04 LTS
- Node.js 22 LTS
- Python 3 + pip + venv
- build-essential (gcc, make — for native npm addons)
- git, curl, jq, unzip, openssh-client
- Claude Code CLI (`@anthropic-ai/claude-code`)
- tini (proper PID 1 for signal handling)

Need something else? `claude-box shell` into the container and install it — it persists until the container is removed.

## Updating

Claude Code CLI is baked into the Docker image. To update it:

```bash
claude-box build
```

Then remove and recreate containers for projects that need the update:

```bash
claude-box rm
claude-box
```

The CLI warns you when the image is older than 14 days.

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | If set, passed to the container. Alternative to OAuth login. |

## Caveats

- **Windows-first** — Built and tested on Windows 11 with Docker Desktop (WSL2 backend). The `.cmd` wrapper and `cygpath` handling are Windows-specific. On native Linux or macOS, the core bash script should work but the `.cmd` wrapper and `winpty` detection won't apply.
- **Git Bash required** — The CLI is a bash script. On Windows, it requires Git for Windows (specifically `C:\Program Files\Git\bin\bash.exe`). WSL's bash is not used.
- **File watching may be slow** — Docker Desktop's file sharing (via WSL2/grpcfuse) can lag for large projects. Hot reload / watch mode may have a 1-2 second delay compared to native.
- **Container-local state is ephemeral** — Tools installed inside the container (`apt-get install`, `pip install`) persist across sessions but are lost when the container is removed. Project files are safe (they live on the host).
- **One container per project directory** — Running `claude-box` from the same directory always targets the same container. To start fresh, `claude-box rm` first.
- **Port detection is heuristic** — It scans common config files but won't catch every possible port configuration (e.g., ports defined in TypeScript constants or YAML configs). Use the default fallback ports or configure your project's `.env` file.

## Known Issues

- **CRLF line endings** — If you edit `entrypoint.sh` on Windows, it may get CRLF endings that break the shebang. The Dockerfile runs `dos2unix` during build to handle this, and `install.sh` strips CRLFs from the CLI script.
- **First PowerShell invocation may be slow** — The `.cmd` → Git Bash → Docker chain has some startup overhead (~1-2 seconds).
- **Image staleness** — The Claude Code CLI version is frozen at build time. If Claude Code releases updates, you need to `claude-box build` to pick them up.

## Project Structure

```
claude-box/
  claude-box        # Main CLI script (bash)
  claude-box.cmd    # Windows CMD/PowerShell wrapper
  Dockerfile        # Container image definition
  entrypoint.sh     # Container startup (SSH, git, auth setup)
  install.sh        # Build image + install CLI to ~/.local/bin
  .dockerignore     # Limits build context to entrypoint.sh only
```

## License

MIT
