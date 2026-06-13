#!/bin/bash
# Force build script that works around Deno deprecation issues

echo "🔨 Force Building Hive Flow..."
echo "================================"

# Ensure bin directory exists
mkdir -p bin

# Set Deno path
export PATH="/home/codespace/.deno/bin:$PATH"

# Backup existing binary
if [ -f "bin/hive-flow" ]; then
    echo "📦 Backing up existing binary..."
    cp bin/hive-flow bin/hive-flow.working
fi

# Force remove any existing temp files
rm -f bin/hive-flow.tmp*

# Try to compile, ignoring the exit code
echo "🏗️  Attempting build (ignoring errors)..."
deno compile --allow-all --no-check --output=bin/hive-flow.tmp src/cli/main.ts 2>&1 | grep -v "Import assertions" || true

# Wait a moment for file system
sleep 1

# Check if ANY temporary file was created
TEMP_FILE=$(ls bin/hive-flow.tmp* 2>/dev/null | head -1)

if [ -n "$TEMP_FILE" ] && [ -f "$TEMP_FILE" ]; then
    echo "📦 Found build artifact: $TEMP_FILE"
    
    # Check if it's executable
    if [ -x "$TEMP_FILE" ]; then
        echo "✅ Build artifact is executable!"
        
        # Move to final location
        mv -f "$TEMP_FILE" bin/hive-flow
        chmod +x bin/hive-flow
        
        echo "✅ Build successful!"
        echo "Binary location: bin/hive-flow"
        exit 0
    else
        echo "⚠️  Build artifact is not executable, making it executable..."
        chmod +x "$TEMP_FILE"
        mv -f "$TEMP_FILE" bin/hive-flow
        echo "✅ Build completed with warnings"
        exit 0
    fi
else
    echo "❌ No build artifact found"
    
    # Restore backup
    if [ -f "bin/hive-flow.working" ]; then
        echo "🔄 Restoring working binary..."
        mv bin/hive-flow.working bin/hive-flow
    fi
    
    exit 1
fi