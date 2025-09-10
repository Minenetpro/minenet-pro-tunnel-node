#!/usr/bin/env bash
set -euo pipefail

# frps Management Server installer (Linux + systemd)
# - Clones repo https://github.com/wynn-dev/minenet-pro-tunnel-node
# - Installs FRP v0.64.0 (frps) to /usr/local/bin
# - Installs Bun if missing
# - Creates systemd service and enables autostart
# - Generates API secret (mnet_<30 base62>) if not present, prints to console

REPO_URL=${REPO_URL:-"https://github.com/wynn-dev/minenet-pro-tunnel-node"}
APP_DIR=${APP_DIR:-"/opt/minenet-pro-tunnel-node"}
SERVICE_NAME=${SERVICE_NAME:-"minenet-pro-frps-manager"}
ENV_FILE=${ENV_FILE:-"/etc/${SERVICE_NAME}.env"}
PORT=${PORT:-3000}
FRP_VERSION=${FRP_VERSION:-"0.64.0"}
FRP_TARBALL="frp_${FRP_VERSION}_linux_amd64.tar.gz"
FRP_URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${FRP_TARBALL}"
RUN_USER=${RUN_USER:-"frpsmgr"}
RUN_GROUP=${RUN_GROUP:-"frpsmgr"}

require_cmd() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "error: required command '$1' is not installed" >&2
		exit 1
	fi
}

require_root() {
	if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
		echo "This script must be run as root. Try: sudo bash $0" >&2
		exit 1
	fi
}

install_bun_if_missing() {
	if command -v bun >/dev/null 2>&1; then
		echo "bun found: $(command -v bun)"
		return
	fi
	echo "bun not found, installing..."
	# Official installer; installs under ~/.bun by default
	# We will symlink to /usr/local/bin/bun for systemd user
	/bin/bash -c "$(curl -fsSL https://bun.sh/install)" </dev/null
	BUN_BIN="${HOME}/.bun/bin/bun"
	if [[ ! -x "$BUN_BIN" ]]; then
		echo "error: bun installation failed" >&2
		exit 1
	fi
	ln -sf "$BUN_BIN" /usr/local/bin/bun
	echo "bun installed at /usr/local/bin/bun"
}

install_frp() {
	echo "Installing frp v${FRP_VERSION} from ${FRP_URL}..."
	require_cmd curl
	require_cmd tar
	TMP_DIR=$(mktemp -d)
	trap 'rm -rf "$TMP_DIR"' EXIT
	cd "$TMP_DIR"
	curl -fL "${FRP_URL}" -o "${FRP_TARBALL}"
	tar -xzf "${FRP_TARBALL}"
	FRP_DIR="frp_${FRP_VERSION}_linux_amd64"
	if [[ ! -d "$FRP_DIR" ]]; then
		echo "error: extracted directory not found" >&2
		exit 1
	fi
	install -m 0755 "$FRP_DIR/frps" /usr/local/bin/frps
	# Optionally install frpc too
	if [[ -f "$FRP_DIR/frpc" ]]; then
		install -m 0755 "$FRP_DIR/frpc" /usr/local/bin/frpc || true
	fi
	echo "frps installed to /usr/local/bin/frps"
}

ensure_service_user() {
	if ! id -u "$RUN_USER" >/dev/null 2>&1; then
		echo "Creating system user: ${RUN_USER}"
		useradd --system --no-create-home --shell /usr/sbin/nologin --user-group "$RUN_USER"
	fi
}

clone_repo() {
	require_cmd git
	if [[ -d "$APP_DIR/.git" ]]; then
		echo "Repo exists at ${APP_DIR}, pulling latest..."
		git -C "$APP_DIR" fetch --all --prune
		git -C "$APP_DIR" reset --hard origin/main
	else
		echo "Cloning ${REPO_URL} into ${APP_DIR}"
		git clone --depth 1 "$REPO_URL" "$APP_DIR"
	fi
	chown -R "$RUN_USER":"$RUN_GROUP" "$APP_DIR"
}

install_dependencies() {
	cd "$APP_DIR"
	sudo -u "$RUN_USER" env HOME="/tmp" bun install --no-save --ignore-scripts
}

generate_api_secret() {
	if [[ -f "$ENV_FILE" ]]; then
		# If API_SECRET is already present, keep it
		if grep -qE '^API_SECRET=' "$ENV_FILE"; then
			EXISTING=$(grep -E '^API_SECRET=' "$ENV_FILE" | head -n1 | sed 's/^API_SECRET=\s*//')
			echo "$EXISTING"
			return
		fi
	fi
	# base62, 30 chars
	RAND=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 30)
	echo "mnet_${RAND}"
}

write_env_file() {
	SECRET_VALUE="$1"
	echo "Writing env file to ${ENV_FILE}"
	install -m 0640 -o "$RUN_USER" -g "$RUN_GROUP" /dev/null "$ENV_FILE"
	cat >"$ENV_FILE" <<EOF
API_SECRET=${SECRET_VALUE}
PORT=${PORT}
NODE_ENV=production
EOF
}

write_systemd_unit() {
	echo "Writing systemd unit /etc/systemd/system/${SERVICE_NAME}.service"
	cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=FRPS Management Server (Bun)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${APP_DIR}
ExecStart=/usr/local/bin/bun run index.ts
Restart=always
RestartSec=3
KillSignal=SIGINT
TimeoutStopSec=10
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF
}

enable_and_start() {
	systemctl daemon-reload
	systemctl enable --now ${SERVICE_NAME}.service
}

print_summary() {
	SECRET=$(grep -E '^API_SECRET=' "$ENV_FILE" | sed 's/^API_SECRET=\s*//')
	echo ""
	echo "Installation complete."
	echo "Service: ${SERVICE_NAME}.service"
	echo "API Secret: ${SECRET}"
	echo ""
	echo "Test health check:"
	echo "  curl -s http://localhost:${PORT}/healthz"
	echo "List processes (requires bearer):"
	echo "  curl -H 'Authorization: Bearer ${SECRET}' http://localhost:${PORT}/frps"
}

main() {
	require_root
	require_cmd curl
	require_cmd tar
	install_bun_if_missing
	install_frp
	ensure_service_user
	clone_repo
	install_dependencies
	SECRET=$(generate_api_secret)
	write_env_file "$SECRET"
	write_systemd_unit
	enable_and_start
	print_summary
}

main "$@"


