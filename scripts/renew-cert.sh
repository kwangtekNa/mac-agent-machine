#!/usr/bin/env bash
# TLS 인증서 갱신 (launchd dev.mam.certrenew 가 주 1회 실행, 수동 실행도 가능).
# 사용법: renew-cert.sh <tailscale-bin> <hostname>
set -euo pipefail

TAILSCALE="${1:?tailscale 실행 파일 경로}"
HOSTNAME_ARG="${2:?MagicDNS 호스트명}"
CERT_DIR=/etc/mam/tls
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"

echo "==> $(date -u +%FT%TZ) tailscale cert $HOSTNAME_ARG"
mkdir -p "$CERT_DIR"
"$TAILSCALE" cert --cert-file "$CERT" --key-file "$KEY" "$HOSTNAME_ARG"
chmod 0600 "$CERT" "$KEY"

echo "==> gateway 재시작"
launchctl kickstart -k system/dev.mam.gateway
echo "==> 완료"
