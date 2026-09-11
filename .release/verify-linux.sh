#!/usr/bin/env bash
set -euo pipefail
test "${GITHUB_ACTIONS:-}" = true
test ! -L /opt
test "$(stat -c '%F %U:%G' /opt)" = 'directory root:root'
case "$(stat -c '%a' /opt)" in
  755) ;;
  775|777) sudo chmod 0755 /opt ;;
  *) echo 'Unexpected /opt permissions' >&2; exit 1 ;;
esac
deb=(release/*.deb)
test "${#deb[@]}" -eq 1
trap 'sudo dpkg --purge openmausbot || true' EXIT
sudo --preserve-env=CI,RUNNER_TEMP node scripts/smoke-deb-upgrade.mjs "${deb[0]}"
sudo chown root:root release/linux-unpacked/chrome-sandbox
sudo chmod 4755 release/linux-unpacked/chrome-sandbox
node scripts/check-private-package.mjs /opt/OpenMausBot/resources
node scripts/smoke-browser-bundle.mjs --resources /opt/OpenMausBot/resources
OMB_SMOKE_DIST=/opt/OpenMausBot/resources/server node scripts/smoke-packaged-server.mjs --browser-bundle /opt/OpenMausBot/resources/browser-engine
OMB_KEEP_SMOKE_DIR=1 OMB_SMOKE_INSTALLED_DEB=1 corepack pnpm smoke:linux-package
