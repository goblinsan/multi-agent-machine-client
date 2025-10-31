# Code Maintainability Guidelines

## File Size Limits

The project now enforces file size limits via pre-commit hooks:

- **Warning Threshold:** 400 lines
- **Error Threshold:** 600 lines (blocks commit)

### Why These Limits?

Large files indicate:
- Multiple responsibilities (violates Single Responsibility Principle)
- Difficult to test in isolation
- Hard to understand and maintain
- Increased likelihood of merge conflicts
- Cognitive overload for developers

### Bypass (Not Recommended)

If you absolutely must commit a large file temporarily:
```bash
git commit --no-verify
```

**However:** You should immediately create a refactoring ticket and address it.

## Current Large Files (Need Refactoring)

Files over 500 lines that need attention:

1. `src/workflows/steps/BulkTaskCreationStep.ts` (708 lines)
2. `src/personas/PersonaConsumer.ts` (613 lines) - **Refactoring plan exists**
3. `src/workflows/steps/PersonaRequestStep.ts` (607 lines)
4. `src/workflows/steps/ContextStep.ts` (582 lines)
5. `src/workflows/steps/PlanningLoopStep.ts` (505 lines)
6. `src/git/repository.ts` (504 lines)

See individual refactoring plans in `docs/REFACTORING_PLAN_*.md`

## Refactoring Strategies

### 1. Extract Methods
Break large methods into smaller, focused functions:

```typescript
// ❌ BAD: 200-line method
async executePersonaRequest(params) {
  // ... 200 lines of logic
}

// ✅ GOOD: Composed of smaller methods
async executePersonaRequest(params) {
  const context = await this.extractContext(params);
  const response = await this.callLLM(context);
  await this.publishResult(response);
}
```

### 2. Extract Classes
Move related functionality to separate classes:

```typescript
// ❌ BAD: One class does everything
class PersonaConsumer {
  executeRequest() { }
  extractContext() { }
  readArtifacts() { }
  buildDashboard() { }
}

// ✅ GOOD: Separate concerns
class PersonaConsumer {
  constructor(
    private contextExtractor: ContextExtractor,
    private artifactReader: ArtifactReader
  ) {}
}
```

### 3. Extract Utilities
Move helper functions to utility modules:

```typescript
// ❌ BAD: Utilities mixed with business logic
class MyClass {
  async doWork() { }
  private formatDate() { }
  private parseJson() { }
  private validateEmail() { }
}

// ✅ GOOD: Utilities in separate files
import { formatDate, parseJson, validateEmail } from '../utils';
```

### 4. Use Composition
Prefer composition over inheritance:

```typescript
// ✅ GOOD: Compose behavior
class PersonaConsumer {
  constructor(
    private retryHandler: RetryHandler,
    private messageFormatter: MessageFormatter
  ) {}
}
```

## Pre-Commit Checks

Current checks (in order):
1. 📏 **File size check** (< 600 lines)
2. 🔍 **TypeScript type check** (no type errors)
3. 🎨 **ESLint** (code quality)
4. ✨ **Lint-staged** (format staged files)
5. 🧪 **Tests** (all must pass, none skipped)

## Metrics to Track

### File Complexity
```bash
# Check file size
wc -l src/personas/PersonaConsumer.ts

# Count methods
grep -E "^\s*(private|public|async)" src/personas/PersonaConsumer.ts | wc -l

# Find largest files
find src -name "*.ts" -exec wc -l {} \; | sort -rn | head -20
```

### Cyclomatic Complexity
Use ESLint's complexity rule (already configured):
```json
{
  "complexity": ["warn", 15]
}
```

## When to Refactor?

### Immediate (Blocks Development)
- File > 600 lines
- Method > 100 lines
- Cyclomatic complexity > 20
- Cannot write tests without mocking 5+ dependencies

### Soon (Technical Debt)
- File > 400 lines
- Method > 50 lines
- Class has > 10 public methods
- Difficult to understand in < 5 minutes

### Eventually (Nice to Have)
- File could be split logically
- Repeated patterns that could be abstracted
- Opportunities for better naming

## Resources

- [Single Responsibility Principle](https://en.wikipedia.org/wiki/Single-responsibility_principle)
- [Refactoring Guru](https://refactoring.guru/)
- [Clean Code by Robert Martin](https://www.amazon.com/Clean-Code-Handbook-Software-Craftsmanship/dp/0132350882)

## Questions?

Discuss in #engineering channel or create a refactoring ticket.
