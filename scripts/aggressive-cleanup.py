#!/usr/bin/env python3
"""
AGGRESSIVE DEAD CODE REMOVAL
Delete ALL unused imports, parameters, and variables.
NO underscores, NO keeping "just in case" - DELETE IT ALL.
"""

import re
import subprocess
from pathlib import Path
from collections import defaultdict

def get_unused_items():
    """Get all unused items from ESLint"""
    result = subprocess.run(
        ['npm', 'run', 'lint'],
        capture_output=True,
        text=True,
        cwd='/Users/jamescoghlan/code/multi-agent-machine-client'
    )
    
    output = result.stdout + result.stderr
    lines = output.split('\n')
    
    unused = defaultdict(list)
    current_file = None
    
    for line in lines:
        # Match file paths
        if line.strip().startswith('/Users'):
            current_file = line.strip()
        # Match unused warnings
        elif "'" in line and 'is defined but never used' in line:
            match = re.search(r"'([^']+)'", line)
            if match and current_file:
                symbol = match.group(1)
                # Get line number
                line_match = re.search(r'^\s*(\d+):', line)
                if line_match:
                    line_num = int(line_match.group(1))
                    unused[current_file].append((line_num, symbol))
    
    return unused

def remove_from_import(content, symbol):
    """Remove a symbol from import statements"""
    # Remove from destructured imports: { symbol }
    content = re.sub(rf'\{{\s*{re.escape(symbol)}\s*\}}', '{}', content)
    # Remove from multi-symbol imports: symbol,  or , symbol
    content = re.sub(rf',\s*{re.escape(symbol)}\s*[,}}]', ',', content)
    content = re.sub(rf'\{{\s*{re.escape(symbol)}\s*,', '{', content)
    # Clean up empty imports
    content = re.sub(r'import\s+\{\s*\}\s+from\s+[\'"][^\'\"]+[\'"];\s*\n', '', content)
    return content

def remove_parameter(content, param, line_num):
    """Remove unused parameter from function signature"""
    lines = content.split('\n')
    if line_num <= len(lines):
        line = lines[line_num - 1]
        # Remove parameter
        line = re.sub(rf',\s*{re.escape(param)}\s*:', ',', line)
        line = re.sub(rf'\(\s*{re.escape(param)}\s*:', '(', line)
        line = re.sub(rf':\s*[^,)]+,\s*', ': ', line)
        lines[line_num - 1] = line
        content = '\n'.join(lines)
    return content

def main():
    print("🔥 AGGRESSIVE DEAD CODE REMOVAL - DELETING EVERYTHING UNUSED 🔥\n")
    
    unused = get_unused_items()
    
    if not unused:
        print("✅ No unused items found!")
        return
    
    total_removed = 0
    
    for filepath, items in unused.items():
        # Convert to Path
        path = Path(filepath)
        if not path.exists():
            continue
            
        print(f"\n📁 {path.relative_to(Path.cwd())}")
        content = path.read_text()
        original = content
        
        for line_num, symbol in sorted(items, reverse=True):
            print(f"  ❌ DELETE: {symbol} (line {line_num})")
            
            # Try to remove from imports
            content = remove_from_import(content, symbol)
            
            # If it's a parameter, try to remove it
            if any(keyword in content for keyword in ['function', 'async', '=>']):
                content = remove_parameter(content, symbol, line_num)
            
            total_removed += 1
        
        if content != original:
            path.write_text(content)
            print(f"  ✅ Saved")
    
    print(f"\n🎯 Total items removed: {total_removed}")
    print("\nRunning tests...")
    
    # Run tests
    result = subprocess.run(
        ['npm', 'test'],
        capture_output=True,
        cwd='/Users/jamescoghlan/code/multi-agent-machine-client'
    )
    
    if result.returncode == 0:
        print("✅ ALL TESTS PASSING")
    else:
        print("❌ TESTS FAILED - review changes")

if __name__ == '__main__':
    main()
