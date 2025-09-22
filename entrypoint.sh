#!/bin/sh
# entrypoint.sh

# Exit immediately if a command exits with a non-zero status.
set -e

# Define the target file(s) and the placeholder URL.
TARGET_FILES="/app/public/assets/*.js"
PLACEHOLDER_URL="ws://localhost:3000"

# Check if the WEBSOCKET_URL environment variable is set and not empty.
if [ -n "$WEBSOCKET_URL" ]; then
  echo "Replacing WebSocket URL in production assets..."
  # Use a different delimiter (#) for sed to avoid issues with slashes in the URL.
  sed -i "s#${PLACEHOLDER_URL}#${WEBSOCKET_URL}#g" $TARGET_FILES
fi

# Execute the command passed to this script (e.g., "node", "index.js").
exec "$@"
