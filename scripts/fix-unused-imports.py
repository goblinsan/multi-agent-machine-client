#!/usr/bin/env python3
"""Remove unused WorkflowStepConfig imports from workflow steps"""

import re
import sys
from pathlib import Path

files_to_fix = [
    "src/workflows/steps/ContextStep.ts",
    "src/workflows/steps/GitOperationStep.ts",
    "src/workflows/steps/MilestoneStatusCheckStep.ts",
    "src/workflows/steps/PersonaRequestStep.ts",
    "src/workflows/steps/PlanEvaluationStep.ts",
    "src/workflows/steps/PlanningLoopStep.ts",
    "src/workflows/steps/PlanningStep.ts",
    "src/workflows/steps/PullTaskStep.ts",
    "src/workflows/steps/QAStep.ts",
    "src/workflows/steps/ReviewFailureTasksStep.ts",
    "src/workflows/steps/SimpleTaskStatusStep.ts",
    "src/workflows/steps/TaskUpdateStep.ts",
    "src/workflows/steps/VariableResolutionStep.ts",
]

for filepath in files_to_fix:
    path = Path(filepath)
    if not path.exists():
        print(f"Skipping {filepath} (not found)")
        continue
    
    content = path.read_text()
    
    # Remove ", WorkflowStepConfig" from import line
    new_content = re.sub(
        r'(import\s+{[^}]*), WorkflowStepConfig([^}]*}\s+from\s+[\'"]\.\.\/engine\/WorkflowStep\.js[\'"])',
        r'\1\2',
        content
    )
    
    if new_content != content:
        path.write_text(new_content)
        print(f"Fixed: {filepath}")
    else:
        print(f"No change: {filepath}")

print("Done!")
