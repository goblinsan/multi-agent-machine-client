#!/usr/bin/env python3
"""Remove unused WorkflowCoordinator imports from test files"""

import re
from pathlib import Path

files_to_check = [
    "tests/blockedTaskResolution.test.ts",
    "tests/commitAndPush.test.ts",
    "tests/handleCoordinator.overrides.test.ts",
    "tests/happyPath.test.ts",
    "tests/initialPlanningAckAndEval.test.ts",
    "tests/processedOnce.test.ts",
    "tests/qaFailure.test.ts",
    "tests/qaFollowupExecutes.test.ts",
    "tests/qaPlanIterationMax.test.ts",
    "tests/qaPmGating.test.ts",
]

for filepath in files_to_check:
    path = Path(filepath)
    if not path.exists():
        print(f"Skipping {filepath} (not found)")
        continue
    
    content = path.read_text()
    
    # Check if WorkflowCoordinator is actually used (not just imported)
    if "WorkflowCoordinator" in content:
        # Count how many times it appears
        count = content.count("WorkflowCoordinator")
        # If it only appears once (in the import), it's unused
        if count == 1 and "import { WorkflowCoordinator }" in content:
            # Remove the import line
            new_content = re.sub(
                r"import \{ WorkflowCoordinator \} from ['\"][^'\"]+['\"];\n",
                "",
                content
            )
            
            # Also handle case where it's part of a multi-line import
            new_content = re.sub(
                r", WorkflowCoordinator",
                "",
                new_content
            )
            new_content = re.sub(
                r"WorkflowCoordinator, ",
                "",
                new_content
            )
            
            if new_content != content:
                path.write_text(new_content)
                print(f"Fixed: {filepath}")
            else:
                print(f"No change needed: {filepath}")
        else:
            print(f"Used in {filepath} ({count} times)")
    else:
        print(f"Not found in {filepath}")

print("Done!")
