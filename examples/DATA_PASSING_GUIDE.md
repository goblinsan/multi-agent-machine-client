# Passing Data to create-project.ts

There are **5 different ways** to pass project data to the `create-project.ts` script:

---

## Method 1: Use Default Example Data (No Arguments)

**Command:**

```bash
tsx examples/create-project.ts
```

**What it does:**

- Uses `examples/project-setup-example.json` by default
- Creates an e-commerce project with 9 milestones and 47 tasks

**When to use:**

- Testing the script
- Learning how it works
- Quick demo

---

## Method 2: Pass JSON File Path as Argument

**Command:**

```bash
tsx examples/create-project.ts path/to/your-project.json
```

**Examples:**

```bash
# Relative path
tsx examples/create-project.ts examples/custom-project-example.json

# Absolute path
tsx examples/create-project.ts /Users/james/my-projects/project-data.json

# Current directory
tsx examples/create-project.ts ./my-project.json
```

**When to use:**

- You have a pre-defined JSON file
- Most common use case
- Reusable project templates

---

## Method 3: Read from stdin (Pipe or Redirect)

**Command:**

```bash
tsx examples/create-project.ts -
```

**Examples:**

### Pipe from file:

```bash
cat my-project.json | tsx examples/create-project.ts -
```

### Pipe from command:

```bash
echo '{"project":{"name":"Test","slug":"test"},"milestones":[],"tasks":{}}' | tsx examples/create-project.ts -
```

### Generate JSON dynamically:

```bash
node generate-project.js | tsx examples/create-project.ts -
```

### Here-document (multi-line JSON):

```bash
tsx examples/create-project.ts - <<EOF
{
  "project": {
    "name": "Quick Project",
    "slug": "quick-project"
  },
  "milestones": [
    {"name": "Phase 1", "slug": "phase-1", "status": "active"}
  ],
  "tasks": {
    "phase-1": [
      {"title": "Task 1", "status": "open"}
    ]
  }
}
EOF
```

**When to use:**

- Programmatic generation of JSON
- Integration with other tools
- Dynamic project creation from templates

---

## Method 4: Environment Variables (BASE_URL)

**Command:**

```bash
BASE_URL=http://api.example.com tsx examples/create-project.ts my-project.json
```

**Examples:**

```bash
# Local development (default)
tsx examples/create-project.ts my-project.json

# Custom port
BASE_URL=http://localhost:8080 tsx examples/create-project.ts my-project.json

# Remote server
BASE_URL=https://dashboard.production.com tsx examples/create-project.ts my-project.json

# Combine with stdin
BASE_URL=http://localhost:3000 cat project.json | tsx examples/create-project.ts -
```

**When to use:**

- Different environments (dev, staging, production)
- Testing against different API servers
- CI/CD pipelines

---

## Method 5: Import as Module (Programmatic)

**Create a TypeScript file:**

```typescript
// my-setup.ts
import { readFileSync } from "fs";

const projectData = {
  project: {
    name: "My Generated Project",
    slug: "generated-project",
    description: "Programmatically created project",
  },
  milestones: [
    {
      name: "Milestone 1",
      slug: "milestone-1",
      status: "active",
      description: "First milestone",
    },
  ],
  tasks: {
    "milestone-1": [
      {
        title: "Task 1",
        description: "First task",
        status: "open",
        labels: ["setup"],
      },
      {
        title: "Task 2",
        status: "open",
        labels: ["development"],
      },
    ],
  },
};

// Write to temp file
const tempFile = "/tmp/project-data.json";
require("fs").writeFileSync(tempFile, JSON.stringify(projectData, null, 2));

// Execute the script
const { execSync } = require("child_process");
execSync(`tsx examples/create-project.ts ${tempFile}`, { stdio: "inherit" });
```

**Or directly use fetch API:**

```typescript
// direct-api.ts
const BASE_URL = "http://localhost:3000";

async function createProject() {
  // Create project
  const projectRes = await fetch(`${BASE_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "My Project",
      slug: "my-project",
      description: "Created programmatically",
    }),
  });

  const project = await projectRes.json();
  console.log("Project created:", project.id);

  // Create milestone
  const milestoneRes = await fetch(
    `${BASE_URL}/projects/${project.id}/milestones`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Phase 1",
        slug: "phase-1",
        status: "active",
      }),
    },
  );

  const milestone = await milestoneRes.json();

  // Create tasks
  await fetch(`${BASE_URL}/projects/${project.id}/tasks:bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tasks: [
        { title: "Task 1", milestone_id: milestone.id, status: "open" },
        { title: "Task 2", milestone_id: milestone.id, status: "open" },
      ],
    }),
  });

  console.log("✓ Complete!");
}

createProject();
```

**When to use:**

- Custom project generation logic
- Integration with other systems
- Building project templates dynamically
- Automation scripts

---

## Comparison Table

| Method                | Complexity | Flexibility | Use Case                        |
| --------------------- | ---------- | ----------- | ------------------------------- |
| 1. Default (no args)  | ⭐         | ⭐          | Quick testing, demos            |
| 2. File path argument | ⭐⭐       | ⭐⭐⭐      | Most common, reusable templates |
| 3. stdin pipe         | ⭐⭐⭐     | ⭐⭐⭐⭐    | Dynamic generation, automation  |
| 4. Environment vars   | ⭐⭐       | ⭐⭐⭐      | Different environments          |
| 5. Programmatic       | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐  | Full control, custom logic      |

---

## Common Patterns

### Pattern 1: Generate from Template

```bash
# Copy template and customize
cp examples/custom-project-example.json my-project.json
vim my-project.json  # Edit with your data
tsx examples/create-project.ts my-project.json
```

### Pattern 2: Dynamic Generation

```javascript
// generate-project.js
const project = {
  project: {
    name: process.env.PROJECT_NAME || "Default Project",
    slug: process.env.PROJECT_SLUG || "default-project",
  },
  milestones: JSON.parse(process.env.MILESTONES || "[]"),
  tasks: JSON.parse(process.env.TASKS || "{}"),
};

console.log(JSON.stringify(project));
```

```bash
PROJECT_NAME="My Project" \
MILESTONES='[{"name":"M1","slug":"m1","status":"active"}]' \
TASKS='{"m1":[{"title":"T1","status":"open"}]}' \
node generate-project.js | tsx examples/create-project.ts -
```

### Pattern 3: CI/CD Integration

```yaml
# .github/workflows/setup-project.yml
name: Setup Project
on: workflow_dispatch

jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3

      - name: Create project from template
        run: |
          tsx examples/create-project.ts project-templates/production.json
        env:
          BASE_URL: ${{ secrets.DASHBOARD_API_URL }}
```

### Pattern 4: Interactive CLI

```typescript
// interactive-setup.ts
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ask = (question: string): Promise<string> => {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
};

async function interactiveSetup() {
  const name = await ask("Project name: ");
  const slug = await ask("Project slug: ");
  const milestoneCount = parseInt(await ask("Number of milestones: "));

  const projectData = {
    project: { name, slug, description: "" },
    milestones: [],
    tasks: {},
  };

  // ... collect milestone data interactively

  // Save to temp file and run
  const fs = require("fs");
  fs.writeFileSync("/tmp/project.json", JSON.stringify(projectData));

  const { execSync } = require("child_process");
  execSync("tsx examples/create-project.ts /tmp/project.json", {
    stdio: "inherit",
  });

  rl.close();
}

interactiveSetup();
```

---

## Summary

**Recommended approach for most users:**

```bash
# 1. Create/edit your project JSON file
vim my-project.json

# 2. Run the script
tsx examples/create-project.ts my-project.json
```

**Recommended for automation:**

```bash
# Generate JSON dynamically and pipe
./generate-my-project.sh | tsx examples/create-project.ts -
```

**Recommended for different environments:**

```bash
# Use environment variables
BASE_URL=https://api.prod.com tsx examples/create-project.ts my-project.json
```
