#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# GOLDPAY Production Database Backup & WAL Archival Script
# ==============================================================================

BACKUP_DIR="${BACKUP_DIR:-/var/backups/goldpay}"
TIMESTAMP="$(date -u +"%Y%m%d_%H%M%SZ")"
DATABASE_URL="${DATABASE_URL:-postgres://gram:password@127.0.0.1:5432/gram}"
BACKUP_FILE="${BACKUP_DIR}/goldpay_db_${TIMESTAMP}.dump"
LOG_FILE="${BACKUP_DIR}/goldpay_backup_${TIMESTAMP}.log"

mkdir -p "${BACKUP_DIR}"

echo "[${TIMESTAMP}] Starting GOLDPAY production database backup..." | tee -a "${LOG_FILE}"

# Execute custom-format binary dump with pre-data, data, and post-data
pg_dump \
  --dbname="${DATABASE_URL}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${BACKUP_FILE}" 2>> "${LOG_FILE}"

BACKUP_SIZE="$(du -h "${BACKUP_FILE}" | cut -f1)"
echo "[$(date -u +"%Y%m%d_%H%M%SZ")] Backup completed successfully: ${BACKUP_FILE} (${BACKUP_SIZE})" | tee -a "${LOG_FILE}"

# Optional SHA256 checksum generation for WORM compliance
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
echo "[$(date -u +"%Y%m%d_%H%M%SZ")] SHA256 checksum generated: $(cat "${BACKUP_FILE}.sha256")" | tee -a "${LOG_FILE}"
