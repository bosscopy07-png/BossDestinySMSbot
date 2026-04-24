#!/bin/bash

# OTP Bot Backup Script
# Run daily via cron: 0 3 * * * /path/to/backup.sh

BACKUP_DIR="/backup/otp-bot"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup MongoDB
echo "Backing up MongoDB..."
mongodump --uri="$DATABASE_URL" --out="$BACKUP_DIR/mongo_$DATE"

# Compress
echo "Compressing backup..."
tar -czf "$BACKUP_DIR/backup_$DATE.tar.gz" -C "$BACKUP_DIR" "mongo_$DATE"
rm -rf "$BACKUP_DIR/mongo_$DATE"

# Upload to S3 (optional)
if [ -n "$S3_BUCKET" ]; then
    echo "Uploading to S3..."
    aws s3 cp "$BACKUP_DIR/backup_$DATE.tar.gz" "s3://$S3_BUCKET/backups/"
fi

# Clean old backups
echo "Cleaning old backups..."
find $BACKUP_DIR -name "backup_*.tar.gz" -mtime +$RETENTION_DAYS -delete

echo "Backup completed: backup_$DATE.tar.gz"
