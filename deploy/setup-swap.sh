#!/usr/bin/env bash
# 2 GB de swap en NVMe para que el OOM killer no tumbe Postgres/n8n.
set -euo pipefail
if swapon --show | grep -q .; then
  echo "Ya hay swap activa:"
  swapon --show
  exit 0
fi
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10
grep -q vm.swappiness /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
echo "Swap lista:"
free -h
