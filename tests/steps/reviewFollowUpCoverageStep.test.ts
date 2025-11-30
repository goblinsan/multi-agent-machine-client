import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ReviewFollowUpCoverageStep } from "../../src/workflows/steps/ReviewFollowUpCoverageStep.js";

vi.mock("../../src/logger.js", () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe("ReviewFollowUpCoverageStep", () => {
	let context: WorkflowContext;
	let transport: any;

	beforeEach(() => {
		transport = {};
		context = new WorkflowContext(
			"wf-coverage",
			"proj-001",
			"/tmp/repo",
			"main",
			{
				name: "review-failure-handling",
				version: "2.0.0",
				steps: [],
			},
			transport,
			{},
		);
	});

	it("aborts when QA blocking issues lack test-focused follow-ups", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [
					{
						title: "Define default values",
						description: "Set default config schema fields",
					},
				],
				review_type: "qa",
				normalized_review: {
					reviewType: "qa",
					hasBlockingIssues: true,
					blockingIssues: [
						{
							title: "Tests missing",
							description: "QA cannot run tests because Vitest is not installed",
							severity: "high",
							blocking: true,
						},
					],
				},
			},
		});

		await expect(step.execute(context)).rejects.toThrow(
			"PM decision ignored QA test failure",
		);
	});

	it("allows QA flow when PM follow-ups include test remediation", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [
					{
						title: "Install Vitest",
						description: "Add Vitest config and smoke tests",
					},
				],
				review_type: "qa",
				normalized_review: {
					reviewType: "qa",
					hasBlockingIssues: true,
					blockingIssues: [
						{
							title: "Tests missing",
							description: "QA cannot run tests because Vitest is not installed",
							severity: "high",
							blocking: true,
						},
					],
				},
			},
		});

		const result = await step.execute(context);
		expect(result.status).toBe("success");
	});

	it("synthesizes normalized blocking follow-ups with severity-aware metadata", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [],
				review_result: null,
				review_type: "qa",
				task: { id: 101, title: "Write tests" },
				external_id_base: "qa-101",
				normalized_review: {
					reviewType: "qa",
					hasBlockingIssues: true,
					blockingIssues: [
						{
							id: "qa-gap-1",
							title: "Config mismatch",
							description: "Configuration defaults missing in schema",
							severity: "high",
							blocking: true,
							labels: ["qa-gap", "infra"],
						},
					],
				},
			},
		});

		const result = await step.execute(context);
		const tasks = result.outputs?.follow_up_tasks ?? [];
		const summary = result.outputs?.metadata?.summary;

		expect(result.status).toBe("success");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].priority).toBe("high");
		expect(tasks[0].category).toBe("urgent");
		expect(tasks[0].labels).toEqual(
			expect.arrayContaining([
				"qa-gap",
				"infra",
				"coordination",
				"qa_follow_up",
			]),
		);
		expect(tasks[0].external_id).toBe("qa-101-gap-qa-gap-1");
		expect(summary).toMatchObject({
			totalCoverageItems: 1,
			synthesizedFollowUps: 1,
			blockingFingerprints: ["qa-gap-1"],
		});
	});

	it("does not synthesize follow-ups when existing tasks already cover the issue", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [],
				review_result: null,
				review_type: "qa",
				existing_tasks: [
					{
						description: "configuration defaults missing in schema",
					},
				],
				normalized_review: {
					reviewType: "qa",
					hasBlockingIssues: true,
					blockingIssues: [
						{
							id: "qa-gap-1",
							title: "Config mismatch",
							description: "Configuration defaults missing in schema",
							severity: "high",
						},
					],
				},
			},
		});

		const result = await step.execute(context);
		const tasks = result.outputs?.follow_up_tasks ?? [];
		const synthesized = result.outputs?.synthesized_follow_ups ?? [];
		const summary = result.outputs?.metadata?.summary;

		expect(tasks).toHaveLength(0);
		expect(synthesized).toHaveLength(0);
		expect(summary?.existingTaskMatches).toBe(1);
	});

	it("falls back to raw QA root cause data when normalization is absent", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [],
				review_type: "qa",
				review_result: {
					reviewer: "qa-agent",
					qa_root_cause_analyses: [
						{
							failing_capability: "run-tests",
							impact: "QA cannot validate",
							proposed_fix: "install vitest",
							qa_gaps: ["Missing Vitest harness"],
							suggested_validations: [
								{
									description: "Add vitest suite",
									context: "scripts/test",
									is_critical_blocker: true,
								},
							],
						},
					],
				},
			},
		});

		const result = await step.execute(context);
		const tasks = result.outputs?.follow_up_tasks ?? [];

		expect(tasks).toHaveLength(2);
		expect(tasks[0].labels).toEqual(
			expect.arrayContaining([
				"qa-gap",
				"coordination",
				"qa_follow_up",
			]),
		);
		expect(tasks[0].priority).toBe("critical");
		expect(tasks[0].branch_locks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ branch: "main", policy: "block" }),
				expect.objectContaining({ branch: "qa", policy: "block" }),
			]),
		);
	});

	it("converts root_causes entries into follow-up coverage", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [],
				review_type: "qa",
				review_result: {
					root_causes: [
						{
							type: "missing_dependency",
							description: "Vitest suite cannot run because jsdom is missing",
							suggestion: "npm install jsdom --save-dev",
							severity: "critical",
						},
					],
				},
			},
		});

		const result = await step.execute(context);
		const tasks = result.outputs?.follow_up_tasks ?? [];
		const coverage = result.outputs?.metadata?.summary;

		expect(result.status).toBe("success");
		expect(tasks).toHaveLength(1);
		expect(tasks[0].labels).toEqual(
			expect.arrayContaining([
				"root-cause",
				"qa",
				"qa-gap",
				"coordination",
			]),
		);
		expect(tasks[0].priority).toBe("critical");
		expect(coverage?.coverageItemBreakdown?.qa_root_cause).toBe(1);
	});

	it("forces follow-ups for code review blockers", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [],
				review_type: "code_review",
				normalized_review: {
					reviewType: "code_review",
					hasBlockingIssues: true,
					blockingIssues: [
						{
							id: "code-blocker",
							title: "Code quality failure",
							description:
								"Static analysis found critical bug in authentication module",
							severity: "high",
							labels: ["code-review", "bug"],
							blocking: true,
						},
					],
				},
				existing_tasks: [],
				external_id_base: "code-77",
			},
		});

		const result = await step.execute(context);
		const tasks = result.outputs?.follow_up_tasks ?? [];

		expect(tasks).toHaveLength(1);
		expect(tasks[0].title).toContain("Review Gap");
		expect(tasks[0].priority).toBe("high");
		expect(tasks[0].labels).toEqual(
			expect.arrayContaining([
				"code-review",
				"bug",
				"blocking",
				"coordination",
				"qa_follow_up",
			]),
		);
		expect(tasks[0].external_id).toBe("code-77-gap-code-blocker");
	});

	it("generates follow-ups for security critical issues", async () => {
		const step = new ReviewFollowUpCoverageStep({
			name: "enforce_follow_up_coverage",
			type: "ReviewFollowUpCoverageStep",
			config: {
				follow_up_tasks: [],
				review_type: "security_review",
				normalized_review: {
					reviewType: "security_review",
					hasBlockingIssues: true,
					blockingIssues: [
						{
							id: "sec-critical",
							title: "SQL injection",
							description: "User input concatenated into SQL query",
							severity: "critical",
							labels: ["security", "critical"],
							blocking: true,
						},
					],
				},
				existing_tasks: [],
				external_id_base: "security-88",
			},
		});

		const result = await step.execute(context);
		const tasks = result.outputs?.follow_up_tasks ?? [];

		expect(tasks).toHaveLength(1);
		expect(tasks[0].priority).toBe("critical");
		expect(tasks[0].category).toBe("urgent");
		expect(tasks[0].labels).toEqual(
			expect.arrayContaining([
				"security",
				"critical",
				"blocking",
				"coordination",
				"qa_follow_up",
			]),
		);
		expect(tasks[0].branch_locks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ branch: "main", policy: "block" }),
			]),
		);
	});
});

