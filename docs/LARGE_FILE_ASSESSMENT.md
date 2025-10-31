# Large File Refactoring Assessment - Updated

## Status
✅ **Completed**: 
- PersonaConsumer.ts: 613 → 339 lines (45% reduction)
- repository.ts: 504 → 19 lines (96% reduction)

## Remaining Targets (400+ lines)

### Top Priority Candidates

#### 1. **DiffParser.ts** - 467 lines ⭐ RECOMMENDED NEXT
**Location**: `src/agents/parsers/DiffParser.ts`
**Type**: Class-based with static methods
**Complexity**: Medium
**Risk**: Low (focused domain, well-tested)

**Methods identified**:
- `parsePersonaResponse()` - Main entry point
- `cleanResponse()` - Text preprocessing
- `extractDiffBlocks()` - Block extraction
- `extractFencedDiffBlocks()` - Code fence handling
- `extractRawDiffBlocks()` - Raw diff handling
- `convertDiffBlocksToEditSpec()` - Conversion logic
- `parseDiffBlock()` - Individual block parsing
- `extractFileContentFromDiff()` - Content extraction
- `validateEditSpec()` - Validation logic

**Refactoring Strategy**:
```
DiffParser.ts (facade) - 50 lines
├── extraction/
│   ├── BlockExtractor.ts - Extract diff blocks from text
│   └── ContentExtractor.ts - Extract file content from blocks
├── conversion/
│   └── DiffToEditSpec.ts - Convert diffs to edit operations
├── validation/
│   └── EditSpecValidator.ts - Validate edit specs
└── utils/
    └── TextCleaner.ts - Text preprocessing utilities
```

**Estimated outcome**: 467 → ~60 lines main file

---

#### 2. **fileops.ts** - 476 lines
**Location**: `src/fileops.ts`
**Type**: Function-based utilities
**Complexity**: Medium
**Risk**: Medium (used widely)

**Main functions**:
- `applyEditOps()` - Apply edit operations to files
- `parseUnifiedDiffToEditSpec()` - Parse unified diffs
- `applyHunksToLines()` - Apply hunks to file content
- `upsertFile()` - Write files safely
- `writeDiagnostic()` - Write diagnostic files
- `normalizeRoot()`, `insideRepo()`, `extAllowed()` - Utilities

**Refactoring Strategy**:
```
fileops.ts (facade) - 30 lines
├── operations/
│   ├── FileOperations.ts - Upsert, delete operations
│   └── EditApplication.ts - Apply edit specs
├── parsing/
│   └── UnifiedDiffParser.ts - Parse unified diffs
├── validation/
│   └── PathValidation.ts - Path safety checks
└── utils/
    └── FileUtils.ts - Helper utilities
```

**Estimated outcome**: 476 → ~40 lines main file

---

#### 3. **taskManager.ts** - 468 lines
**Location**: `src/tasks/taskManager.ts`
**Type**: Mixed (class + functions)
**Complexity**: High
**Risk**: Medium-High (core business logic)

**Not recommended yet** - Wait until simpler files are done

---

### Workflow Step Files (High complexity, defer)

#### BulkTaskCreationStep.ts - 708 lines
**Risk**: High (complex business logic)
**Recommendation**: Defer until pattern is proven

#### PersonaRequestStep.ts - 607 lines
**Risk**: High (complex coordination)
**Recommendation**: Defer until pattern is proven

#### ContextStep.ts - 582 lines
**Risk**: Medium-High
**Recommendation**: Defer until pattern is proven

#### PlanningLoopStep.ts - 505 lines
**Risk**: High (complex state machine)
**Recommendation**: Defer until pattern is proven

#### PlanEvaluationStep.ts - 484 lines
**Risk**: High
**Recommendation**: Defer until pattern is proven

#### ReviewFailureTasksStep.ts - 455 lines
**Risk**: Medium-High
**Recommendation**: Defer until pattern is proven

---

### Coordinator/Engine Files (High risk, defer)

#### WorkflowCoordinator.ts - 494 lines
**Risk**: Very High (core orchestration)
**Recommendation**: Defer indefinitely

#### WorkflowEngine.ts - 445 lines
**Risk**: Very High (core engine)
**Recommendation**: Defer indefinitely

#### LocalTransport.ts - 467 lines
**Risk**: High (message transport)
**Recommendation**: Defer

---

## Recommendation Priority

### Next 3 Targets (in order):
1. ✅ **DiffParser.ts** (467 lines) - Low risk, clear domain separation
2. **fileops.ts** (476 lines) - Medium risk, utilities with clear responsibilities
3. **(Evaluate after #1 and #2)** - Reassess based on patterns learned

### Why DiffParser.ts is the best next choice:
- ✅ **Clear domain**: Parsing and converting diffs (single responsibility)
- ✅ **Low coupling**: Few external dependencies
- ✅ **Well-tested**: Likely has comprehensive test coverage
- ✅ **Class-based**: Easy to extract static methods into modules
- ✅ **High reuse potential**: Extracted parsers could be used elsewhere
- ✅ **Similar to PersonaConsumer**: Static methods that can become functions

### Pattern to follow:
Same as PersonaConsumer and repository.ts:
1. Analyze all methods and group by responsibility
2. Extract focused modules (100-200 lines each)
3. Keep main file as facade with re-exports
4. Run tests continuously
5. Document the refactoring

---

## Files to Skip

**Don't refactor these** (risk too high or not worth it):
- WorkflowCoordinator.ts - Core orchestration, too risky
- WorkflowEngine.ts - Core engine, too risky
- Any workflow step files - Complex business logic, wait for proven pattern
- taskManager.ts - Core business logic, high risk

---

**Updated**: 2025-10-31  
**Completed Refactorings**: 2 (PersonaConsumer, repository)  
**Next Target**: DiffParser.ts
