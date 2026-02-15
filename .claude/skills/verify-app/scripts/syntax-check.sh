#!/bin/bash
# Syntax check all JavaScript files in Plexd

FILES=(
    "server.js"
    "web/js/app.js"
    "web/js/stream.js"
    "web/js/grid.js"
    "web/js/remote.js"
)

ERRORS=0

echo "=== Plexd Syntax Check ==="
echo ""

for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        if node --check "$file" 2>/dev/null; then
            echo "PASS: $file"
        else
            echo "FAIL: $file"
            node --check "$file" 2>&1
            ((ERRORS++))
        fi
    else
        echo "SKIP: $file (not found)"
    fi
done

echo ""
echo "=== Summary ==="
if [ $ERRORS -eq 0 ]; then
    echo "All syntax checks passed"
    exit 0
else
    echo "$ERRORS file(s) have syntax errors"
    exit 1
fi
