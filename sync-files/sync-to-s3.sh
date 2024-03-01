# Sync local files to S3
# The current directory is recursively synced to the S3 bucket
aws s3 sync ./files-to-sync s3://file-server-sync-bucket-test/ --delete --exclude .DS_Store