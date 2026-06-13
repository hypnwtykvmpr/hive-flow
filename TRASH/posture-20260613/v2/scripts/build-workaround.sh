#!/bin/bash
# Workaround build script for Deno deprecation warning

echo "🔨 Building Hive Flow with workaround..."

# Ensure bin directory exists
mkdir -p bin

# Set Deno path
export PATH="/home/codespace/.deno/bin:$PATH"

# First, try to build normally to a temp file
echo "Attempting build..."

# Build command that continues despite warnings
(deno compile --allow-all --no-check --output=bin/hive-flow.tmp src/cli/main.ts 2>&1 || true) | grep -v "Import assertions are deprecated"

# Check if the temporary binary was created despite the error
if [ -f "bin/hive-flow.tmp" ]; then
    echo "✅ Build artifact created!"
    
    # The binary might still work, so let's test it
    if bin/hive-flow.tmp --version &>/dev/null; then
        echo "✅ Binary is functional!"
        
        # Backup existing binary
        if [ -f "bin/hive-flow" ]; then
            cp bin/hive-flow bin/hive-flow.backup
        fi
        
        # Replace with new binary
        mv bin/hive-flow.tmp bin/hive-flow
        chmod +x bin/hive-flow
        echo "✅ Build successful!"
        exit 0
    else
        echo "❌ Binary is not functional"
        rm -f bin/hive-flow.tmp
    fi
fi

# If we get here, try bundling as a fallback
echo "Trying bundle approach..."

# Bundle the TypeScript to JavaScript first
if deno bundle src/cli/main.ts bin/hive-flow.bundle.js &>/dev/null; then
    # Create a wrapper script
    cat > bin/hive-flow.new << 'EOF'
#!/usr/bin/env -S deno run --allow-all --no-check
import "./hive-flow.bundle.js";
EOF
    
    chmod +x bin/hive-flow.new
    
    # Test the wrapper
    if bin/hive-flow.new --version &>/dev/null; then
        echo "✅ Bundle wrapper is functional!"
        
        # Backup and replace
        if [ -f "bin/hive-flow" ]; then
            cp bin/hive-flow bin/hive-flow.backup
        fi
        mv bin/hive-flow.new bin/hive-flow
        echo "✅ Build successful (bundle mode)!"
        exit 0
    fi
fi

echo "❌ All build attempts failed"
echo "Keeping existing binary in place"
exit 1