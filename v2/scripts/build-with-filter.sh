#!/bin/bash
# Build script that works around Deno compile deprecation warnings

echo "🔨 Building Hive Flow (filtering deprecation warnings)..."

# Ensure bin directory exists
mkdir -p bin

# Set Deno path
export PATH="/home/codespace/.deno/bin:$PATH"

# Remove any existing binary to avoid conflicts
rm -f bin/hive-flow

# Create a temporary script that will capture the build process
cat > /tmp/deno-build.sh << 'EOF'
#!/bin/bash
# Run deno compile and capture all output
deno compile --allow-all --no-check --output bin/hive-flow src/cli/main.ts 2>&1
EOF

chmod +x /tmp/deno-build.sh

# Run the build and capture output
BUILD_OUTPUT=$(/tmp/deno-build.sh)
BUILD_EXIT_CODE=$?

# Check if the binary was created despite the error
if [ -f "bin/hive-flow" ]; then
    echo "✅ Binary created successfully!"
    chmod +x bin/hive-flow
    
    # Test if it works
    if bin/hive-flow --version &>/dev/null; then
        echo "✅ Binary is functional!"
        echo "📍 Location: bin/hive-flow"
        exit 0
    else
        echo "⚠️  Binary was created but may not be functional"
    fi
else
    # Check for temporary files that might have been created
    TEMP_FILES=$(find bin -name "hive-flow.tmp*" -type f 2>/dev/null)
    
    if [ -n "$TEMP_FILES" ]; then
        echo "📦 Found temporary build artifacts..."
        
        for temp_file in $TEMP_FILES; do
            echo "  Checking: $temp_file"
            
            # Check if it's a valid executable
            if file "$temp_file" | grep -q "executable"; then
                echo "  ✅ Valid executable found!"
                
                # Move it to the final location
                mv "$temp_file" bin/hive-flow
                chmod +x bin/hive-flow
                
                if bin/hive-flow --version &>/dev/null; then
                    echo "✅ Build successful!"
                    echo "📍 Location: bin/hive-flow"
                    exit 0
                fi
            fi
        done
    fi
fi

# If we get here, build failed
echo "❌ Build failed"
echo ""
echo "Build output:"
echo "$BUILD_OUTPUT" | grep -v "Import assertions are deprecated"

# Restore backup if available
if [ -f "bin/hive-flow.working-backup" ]; then
    echo ""
    echo "🔄 Restoring working backup..."
    cp bin/hive-flow.working-backup bin/hive-flow
    chmod +x bin/hive-flow
    echo "✅ Backup restored"
fi

exit 1