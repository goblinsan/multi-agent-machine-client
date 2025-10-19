# Review System with Severity Ratings

## Overview

The code review and security review stages now include comprehensive severity-rated findings that allow the Project Manager (PM) to make intelligent decisions about which issues require immediate fixes versus which can be deferred to future work.

## Table of Contents

1. [Severity Levels](#severity-levels)
2. [Code Review System](#code-review-system)
3. [Security Review System](#security-review-system)
4. [Review Logs Storage](#review-logs-storage)
5. [PM Decision Framework](#pm-decision-framework)
6. [Workflow Integration](#workflow-integration)

---

## Severity Levels

All findings from code review and security review are classified into four severity levels:

### Code Review Severities

| Level | Description | Examples | Default Action |
|-------|-------------|----------|----------------|
| **SEVERE** | Blocking issues that prevent compilation or break functionality | Compile errors, syntax errors, critical bugs, broken imports | **MUST** fix immediately |
| **HIGH** | Significant problems that impact maintainability or performance | Major tech debt, performance bottlenecks, architectural violations, missing error handling | **SHOULD** fix before merge |
| **MEDIUM** | Code smells and minor violations | Style violations, small refactoring opportunities, minor DRY violations, unclear naming | Can defer to backlog (stage-dependent) |
| **LOW** | Suggestions and nice-to-haves | Refactoring suggestions, documentation improvements, minor optimizations | Defer to backlog |

### Security Review Severities

| Level | Description | Examples | Default Action |
|-------|-------------|----------|----------------|
| **SEVERE** | Critical vulnerabilities with immediate exploitation risk | Remote Code Execution (RCE), Authentication bypass, Data exposure, SQL injection | **MUST** fix immediately (any stage) |
| **HIGH** | Significant security risks | Known CVEs with exploits, Weak cryptography, XSS, CSRF, Privilege escalation | **SHOULD** fix before merge (production/beta) |
| **MEDIUM** | Security concerns without immediate exploitation | Missing security headers, Outdated dependencies (no known exploit), Weak password policy | Stage-dependent |
| **LOW** | Security hardening opportunities | Defense-in-depth enhancements, Security best practices, Hardening suggestions | Defer to backlog |

---

## Code Review System

### What It Checks

The code-reviewer persona performs comprehensive checks for:

1. **Code Best Practices**
   - Single Responsibility Principle (SRP)
   - DRY (Don't Repeat Yourself) - identifies repeated code
   - Proper separation of concerns

2. **Maintainability Issues**
   - Large files (>500 lines)
   - Long methods (>100 lines)
   - Complex nested logic (deep nesting, cyclomatic complexity)

3. **Compile/Syntax Issues**
   - Syntax errors
   - Type errors
   - Import/module errors

4. **Organization Problems**
   - Poor file structure
   - Unclear naming conventions
   - Missing or inconsistent patterns

5. **Lint Violations**
   - Style guide violations
   - Unused variables
   - Dead code

### Response Format

The code-reviewer returns JSON with severity-organized findings:

```json
{
  "status": "pass" | "fail",
  "summary": "High-level overview of review findings",
  "findings": {
    "severe": [
      {
        "file": "src/auth.ts",
        "line": 45,
        "issue": "Syntax error: missing closing brace",
        "recommendation": "Add closing brace at line 45"
      }
    ],
    "high": [
      {
        "file": "src/userService.ts",
        "line": 120,
        "issue": "Method exceeds 150 lines - violates SRP",
        "recommendation": "Split into smaller functions: validateUser, saveUser, notifyUser"
      }
    ],
    "medium": [
      {
        "file": "src/utils.ts",
        "line": null,
        "issue": "Repeated logic in formatDate appears 5 times",
        "recommendation": "Extract to shared utility function"
      }
    ],
    "low": [
      {
        "file": "src/helpers.ts",
        "line": 30,
        "issue": "Variable naming could be more descriptive (x -> userId)",
        "recommendation": "Rename 'x' to 'userId' for clarity"
      }
    ]
  }
}
```

**Status Logic:**
- `status: "fail"` if SEVERE or HIGH findings exist
- `status: "pass"` if only MEDIUM or LOW findings exist (or none)

---

## Security Review System

### What It Checks

The security-review persona performs comprehensive security analysis for:

1. **Vulnerabilities**
   - Injection attacks (SQL, command, etc.)
   - Cross-Site Scripting (XSS)
   - Authentication bypass
   - Insecure dependencies (CVEs)

2. **Secrets Scanning**
   - Hardcoded credentials
   - API keys in code
   - Private keys in repository

3. **License Policy Compliance**
   - Dependency license compatibility
   - GPL contamination risks
   - Commercial license violations

4. **Threat Modeling**
   - Authentication changes
   - Data storage changes
   - Privilege escalation risks

5. **Secure Defaults**
   - Security headers (CSP, HSTS, etc.)
   - Secure cookie configurations
   - TLS/SSL enforcement

### Response Format

The security-review persona returns JSON with severity-organized security findings:

```json
{
  "status": "pass" | "fail",
  "summary": "High-level security assessment summary",
  "findings": {
    "severe": [
      {
        "category": "SQL Injection",
        "file": "src/db/queries.ts",
        "line": 78,
        "vulnerability": "Unsanitized user input in SQL query",
        "impact": "Attacker can execute arbitrary SQL, read/modify database",
        "mitigation": "Use parameterized queries or ORM with prepared statements"
      }
    ],
    "high": [
      {
        "category": "Known CVE",
        "file": "package.json",
        "line": null,
        "vulnerability": "lodash@4.17.15 has CVE-2020-8203 prototype pollution",
        "impact": "Prototype pollution can lead to RCE in some contexts",
        "mitigation": "Upgrade to lodash@4.17.21 or later"
      }
    ],
    "medium": [
      {
        "category": "Missing Security Headers",
        "file": "src/server.ts",
        "line": 25,
        "vulnerability": "Missing Content-Security-Policy header",
        "impact": "Increased XSS risk without CSP protection",
        "mitigation": "Add CSP header with restrictive policy"
      }
    ],
    "low": [
      {
        "category": "Hardening",
        "file": "src/auth.ts",
        "line": null,
        "vulnerability": "Password hashing uses default cost factor",
        "impact": "Could be more resistant to brute force",
        "mitigation": "Consider increasing bcrypt cost factor to 12"
      }
    ]
  }
}
```

**Status Logic:**
- `status: "fail"` if SEVERE or HIGH findings exist
- `status: "pass"` if only MEDIUM or LOW findings exist (or none)

---

## Review Logs Storage

All review results are stored in the repository under `.ma/reviews/` for distributed agent access and PM decision-making.

### File Structure

```
.ma/
├── reviews/
│   ├── task-{task-id}-code-review.log
│   └── task-{task-id}-security-review.log
├── qa/
│   └── task-{task-id}-qa.log
├── planning/
│   └── task-{task-id}-plan.log
└── context/
    └── summary.md
```

### Log Format

Each log entry contains:

```
================================================================================
Code Review - 2025-10-19T00:42:23.915Z
Task ID: 004c60d8-68a8-4060-ab5c-e8a364fb085c
Workflow ID: 027432e0-c78b-4b2c-99b2-22bc74dc3541
Branch: milestone/local-log-ingestion
Status: FAIL
Duration: 15427ms
================================================================================

SUMMARY: Found 2 severe compile errors and 3 high-priority maintainability issues

FINDINGS BY SEVERITY:

SEVERE (2):
  - File: src/auth.ts:45
    Issue: Syntax error: missing closing brace
    Recommendation: Add closing brace at line 45
    
  - File: src/types.ts:120
    Issue: Type error: Property 'username' does not exist on type 'User'
    Recommendation: Add 'username: string' to User interface

HIGH (3):
  - File: src/userService.ts:120
    Issue: Method exceeds 150 lines - violates SRP
    Recommendation: Split into smaller functions: validateUser, saveUser, notifyUser
    
  ... (continues)

MEDIUM (5):
  ... (continues)

LOW (8):
  ... (continues)

================================================================================
FULL RESPONSE:
================================================================================

{full JSON response from persona}

================================================================================
```

### Commit Strategy

Review logs are automatically committed and pushed to ensure distributed agents can access them:

```typescript
// Code review log commit message format:
code-review: PASS for task abc123 (severe:0, high:0)
code-review: FAIL for task abc123 (severe:2, high:3)

// Security review log commit message format:
security-review: PASS for task abc123 (severe:0, high:0)
security-review: FAIL for task abc123 (severe:1, high:2)
```

---

## PM Decision Framework

The Project Manager (PM) persona uses a structured decision framework based on:

1. **Severity Counts** - How many SEVERE, HIGH, MEDIUM, LOW findings exist
2. **Project Stage** - Early-stage MVP vs. Production-ready release
3. **Milestone Context** - Completion percentage and priority

### Decision Matrix

#### Code Review Failures

| Findings | Project Stage | Decision | Rationale |
|----------|---------------|----------|-----------|
| SEVERE or HIGH present | Any | **Immediate Fix** | Blocking issues must be resolved |
| Only MEDIUM | Early (<50%) or MVP/POC | **Defer** | Focus on functionality first |
| Only MEDIUM | Beta/Production (>50%) | **Immediate Fix** | Code quality matters for release |
| Only LOW | Any | **Defer** | Nice-to-haves go to backlog |

#### Security Review Failures

| Findings | Project Stage | Decision | Rationale |
|----------|---------------|----------|-----------|
| SEVERE present | Any | **Immediate Fix** | Critical vulnerabilities are non-negotiable |
| HIGH present | Production/Beta | **Immediate Fix** | Security risks unacceptable near release |
| HIGH present | Early | **Context-Dependent** | May defer if blocking development |
| Only MEDIUM | Production | **Immediate Fix** | Security hardening before production |
| Only MEDIUM | Beta | **Defer or Fix** | Case-by-case based on exposure |
| Only MEDIUM | Early | **Defer** | Focus on functionality first |
| Only LOW | Any | **Defer** | Hardening improvements for backlog |

### Stage Detection

The PM analyzes `milestone_name` for stage indicators:

**Early Stage Keywords:** `MVP`, `POC`, `prototype`, `initial`, `foundation`, `spike`

**Beta Stage Keywords:** `beta`, `testing`, `pre-release`, `RC`, `release-candidate`

**Production Stage Keywords:** `production`, `release`, `v1.0`, `GA`, `launch`, `stable`

### PM Response Format

```json
{
  "decision": "defer" | "immediate_fix",
  "reasoning": "Found 2 SEVERE and 3 HIGH findings. These are blocking issues that must be fixed regardless of project stage.",
  "detected_stage": "early",
  "immediate_issues": [
    "SEVERE: Syntax error in src/auth.ts:45",
    "SEVERE: Type error in src/types.ts:120",
    "HIGH: Method too long (150 lines) in src/userService.ts:120"
  ],
  "deferred_issues": [
    "MEDIUM: Repeated logic in src/utils.ts (5 occurrences)",
    "LOW: Variable naming improvement in src/helpers.ts:30"
  ],
  "follow_up_tasks": [
    {
      "title": "Refactor formatDate utility to eliminate duplication",
      "description": "Extract repeated formatDate logic (found 5 times) to shared utility",
      "priority": "medium"
    },
    {
      "title": "Improve variable naming in helpers.ts",
      "description": "Rename generic variables for better code readability",
      "priority": "low"
    }
  ]
}
```

---

## Workflow Integration

### Workflow Steps

The review system integrates into the workflow as follows:

1. **Code Review Step** (`code_review_request`)
   - Runs after QA passes
   - Outputs: `code_review_request_result`, `code_review_request_status`
   - Stores findings in `.ma/reviews/task-{id}-code-review.log`

2. **PM Code Review Prioritization** (`pm_prioritize_code_review_failures`)
   - Runs **only if** code review status == `fail`
   - Receives severity-rated findings and milestone context
   - Outputs: `pm_code_review_decision`
   - Decision: `defer` or `immediate_fix`

3. **Security Review Step** (`security_request`)
   - Runs after code review **passes** (or PM defers failures)
   - Outputs: `security_request_result`, `security_request_status`
   - Stores findings in `.ma/reviews/task-{id}-security-review.log`

4. **PM Security Prioritization** (`pm_prioritize_security_failures`)
   - Runs **only if** security review status == `fail`
   - Receives severity-rated findings and milestone context
   - Outputs: `pm_security_decision`
   - Decision: `defer` or `immediate_fix`

5. **DevOps Review Step** (`devops_request`)
   - Runs after security review **passes** (or PM defers failures)
   - Final gate before marking task done

### Sequential Flow

The workflow enforces **sequential review progression**:

```
QA Pass
  ↓
Code Review
  ↓
  ├─ PASS → Security Review
  └─ FAIL → PM Prioritize Code Review
             ↓
             ├─ defer (with backlog tasks) → Security Review
             └─ immediate_fix → Block workflow, require fixes
  ↓
Security Review
  ↓
  ├─ PASS → DevOps Review
  └─ FAIL → PM Prioritize Security
             ↓
             ├─ defer (with backlog tasks) → DevOps Review
             └─ immediate_fix → Block workflow, require fixes
  ↓
DevOps Review
  ↓
  └─ PASS → Mark Task Done
```

### Workflow Variables

Key variables available in workflow context:

- `${code_review_request_status}` - `pass` or `fail`
- `${code_review_request_result}` - Full JSON with findings
- `${pm_code_review_decision}` - PM's decision JSON
- `${security_request_status}` - `pass` or `fail`
- `${security_request_result}` - Full JSON with findings
- `${pm_security_decision}` - PM's decision JSON
- `${milestone_name}` - For stage detection
- `${milestone_completion_percentage}` - Progress indicator
- `${milestone_status}` - Current milestone state

---

## Benefits

### 1. **Intelligent Prioritization**
- PM can distinguish between "must fix now" and "defer to backlog"
- Avoids blocking early-stage development with minor code style issues
- Ensures critical security vulnerabilities are never deferred

### 2. **Stage-Aware Decisions**
- Early-stage projects focus on functionality
- Production-bound projects enforce higher quality and security standards
- Balances pragmatism with rigor

### 3. **Distributed Workflow Support**
- Review logs committed to repo ensure all agents see same results
- PM on one machine can review findings from code-reviewer on another machine
- Consistent decision-making across distributed architecture

### 4. **Actionable Backlog**
- Deferred issues automatically converted to follow-up tasks
- Each task has title, description, and priority
- Prevents "lost" issues - everything tracked

### 5. **Traceability**
- Complete review history in `.ma/reviews/` logs
- Easy to audit what was found, when, and why decisions were made
- Supports retrospectives and process improvements

---

## Example Scenarios

### Scenario 1: MVP with Minor Style Issues

**Context:** Early-stage MVP, 30% milestone complete

**Code Review Findings:**
- SEVERE: 0
- HIGH: 0
- MEDIUM: 5 (repeated code, long methods)
- LOW: 12 (naming, minor style)

**PM Decision:**
```json
{
  "decision": "defer",
  "reasoning": "Early-stage MVP with only MEDIUM/LOW findings. No blocking issues. Defer code quality improvements to allow rapid functionality development.",
  "detected_stage": "early",
  "immediate_issues": [],
  "deferred_issues": ["All 5 MEDIUM and 12 LOW findings"],
  "follow_up_tasks": [
    {"title": "Code quality improvements for MVP", "priority": "medium"}
  ]
}
```

**Outcome:** Task proceeds to security review, quality issues tracked for later

---

### Scenario 2: Production Release with Security Vulnerability

**Context:** Production release, 85% milestone complete

**Security Review Findings:**
- SEVERE: 1 (SQL injection vulnerability)
- HIGH: 2 (outdated dependency with CVE, missing CSP header)
- MEDIUM: 3 (security headers, weak password policy)
- LOW: 5 (hardening suggestions)

**PM Decision:**
```json
{
  "decision": "immediate_fix",
  "reasoning": "Production-bound release with 1 SEVERE and 2 HIGH security findings. SEVERE SQL injection vulnerability is critical and must be fixed immediately. Cannot proceed to production with these risks.",
  "detected_stage": "production",
  "immediate_issues": [
    "SEVERE: SQL injection in src/db/queries.ts",
    "HIGH: CVE-2020-8203 in lodash dependency",
    "HIGH: Missing Content-Security-Policy header"
  ],
  "deferred_issues": ["3 MEDIUM and 5 LOW findings"],
  "follow_up_tasks": []
}
```

**Outcome:** Workflow blocks, requires immediate fixes before proceeding

---

### Scenario 3: Beta with Mixed Findings

**Context:** Beta release candidate, 70% milestone complete

**Code Review Findings:**
- SEVERE: 0
- HIGH: 1 (150-line method violating SRP)
- MEDIUM: 3 (minor DRY violations)
- LOW: 6 (style suggestions)

**PM Decision:**
```json
{
  "decision": "immediate_fix",
  "reasoning": "Beta release with 1 HIGH finding. The 150-line method violates single responsibility and will cause maintenance issues. Should fix before beta release.",
  "detected_stage": "beta",
  "immediate_issues": ["HIGH: Method too long in src/userService.ts"],
  "deferred_issues": ["3 MEDIUM and 6 LOW findings"],
  "follow_up_tasks": [
    {"title": "Address code style improvements post-beta", "priority": "low"}
  ]
}
```

**Outcome:** Workflow blocks on HIGH finding, defers MEDIUM/LOW to post-beta

---

## Configuration

### Persona Prompts

The enhanced prompts are in `src/personas.ts`:

- `code-reviewer` - Now includes severity definitions and comprehensive check list
- `security-review` - Now includes severity definitions and security domain categories

### Workflow Files

Updated workflows with PM context guidance:

- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Main task workflow
- `src/workflows/definitions/in-review-task-flow.yaml` - Resume workflow for in-review tasks

### Log Writers

New helper functions in `src/process.ts`:

- `writeCodeReviewLog()` - Parses JSON, extracts severity counts, writes structured log
- `writeSecurityReviewLog()` - Parses JSON, extracts severity counts, writes structured log

Both functions:
- Create `.ma/reviews/` directory if needed
- Parse persona JSON response to extract findings
- Write structured log with severity breakdown
- Commit and push log to repo for distributed access
- Handle errors gracefully with logging

---

## Future Enhancements

Potential improvements to consider:

1. **Automated Severity Detection**
   - Use static analysis tools (ESLint, SonarQube) to auto-detect issues
   - Feed results to LLM for severity classification

2. **Trending Analysis**
   - Track severity counts over time per task/milestone
   - Alert when security findings increase

3. **Custom Severity Thresholds**
   - Allow per-project configuration of "acceptable" MEDIUM count
   - Dynamic thresholds based on milestone

4. **Automated Remediation**
   - For LOW/MEDIUM findings, auto-generate fix PRs
   - PM reviews and merges auto-fixes

5. **Integration with Dashboard**
   - Display severity breakdown in UI
   - Filter tasks by review status and severity

---

## Conclusion

The enhanced review system with severity ratings provides:

✅ **Structured findings** organized by impact level  
✅ **Intelligent PM decisions** based on project stage and severity  
✅ **Distributed workflow support** via committed review logs  
✅ **Actionable backlog** with deferred issues tracked as tasks  
✅ **Flexible prioritization** balancing speed and quality  

This system ensures that critical issues are never overlooked while allowing teams to move quickly in early stages and tighten quality standards as projects mature toward production.
