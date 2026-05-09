# dotfiles

Personal configs for pi-mono coding agent and zsh.

## Layout

| Repo path | Symlinked to | Contains |
| --- | --- | --- |
| `pi/` | `~/.pi` | pi-mono coding agent config: `agent/AGENTS.md`, `agent/settings.json`, `agent/skills/`, `agent/extensions/` |
| `zshrc` | `~/.zshrc` | shell config (no secrets) |

Whitelisted via `pi/.gitignore`. Local-only files (`auth.json`, `models.json`, `sessions/`, `bin/`) stay out of git.

## Secrets

API keys live in `~/.zshenv.local` (mode 0600), **not** in this repo. `~/.zshrc` sources it on shell startup:

```zsh
[[ -f ~/.zshenv.local ]] && source ~/.zshenv.local
```

Set this file up by hand on each machine.

## Install on a new machine

```bash
git clone git@github.com:andreylukin/dotfiles.git ~/repos/dotfiles
ln -s ~/repos/dotfiles/pi ~/.pi
ln -s ~/repos/dotfiles/zshrc ~/.zshrc

# Install npm workspaces (permissions launcher + extension + shared).
# postinstall builds, links extension node_modules, and creates
# ~/.local/bin/{permissions,spi} pointing at this repo.
cd ~/repos/dotfiles && npm install
# After install (with ~/.local/bin on PATH):
#   spi <args>          → sandboxed pi (Seatbelt + proxy + gating extension)
#   permissions <args>  → raw launcher (proxy/pi subcommands, --template, etc.)

# Create secrets file
cat > ~/.zshenv.local <<'EOF'
export ANTHROPIC_KEY="..."
export GEMINI_API_KEY="..."
export TODOIST_API_KEY="..."
export MONARCH_TOKEN="..."
EOF
chmod 600 ~/.zshenv.local

# Authenticate pi (writes ~/.pi/agent/auth.json locally)
pi   # then /login
```

## Update flow

```bash
# On the machine where you made changes
git -C ~/repos/dotfiles add -A
git -C ~/repos/dotfiles commit -m "..."
git -C ~/repos/dotfiles push

# On the other machine
git -C ~/repos/dotfiles pull
```

Symlinks make changes apply immediately:
- New/edited skills → pi picks them up on next session
- Shell config changes → open a new shell, or `source ~/.zshrc`

`~/.zshenv.local` is not synced — update it by hand if you rotate keys.
