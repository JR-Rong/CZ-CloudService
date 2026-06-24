#!/usr/bin/env bash
set -euo pipefail

BASTION_HOST="${BASTION_HOST:-60.205.213.254}"
BASTION_PORT="${BASTION_PORT:-2222}"
BASTION_USER="${BASTION_USER:-admin}"
AI_HOST="${AI_HOST:-192.168.100.12}"
AI_USER="${AI_USER:-ubuntu}"

echo "Opening nested interactive SSH session."
echo "No passwords are stored or passed by this script."
echo
echo "Bastion: ${BASTION_USER}@${BASTION_HOST}:${BASTION_PORT}"
echo "AI host: ${AI_USER}@${AI_HOST}"
echo

exec ssh -tt -p "${BASTION_PORT}" "${BASTION_USER}@${BASTION_HOST}" \
  "ssh -tt -o StrictHostKeyChecking=accept-new ${AI_USER}@${AI_HOST}"
