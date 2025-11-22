export function createTaskInjectedWorkflow(workflow: any, task: any): any {
  if (!task || !workflow?.steps) {
    return workflow;
  }

  const modifiedWorkflow = JSON.parse(JSON.stringify(workflow));

  modifiedWorkflow.steps = workflow.steps.filter(
    (step: any) => step.type !== "PullTaskStep",
  );

  modifiedWorkflow.steps.forEach((step: any) => {
    if (step.depends_on && Array.isArray(step.depends_on)) {
      step.depends_on = step.depends_on.filter(
        (dep: string) => dep !== "pull-task",
      );

      if (step.depends_on.length === 0) {
        delete step.depends_on;
      }
    }
  });

  return modifiedWorkflow;
}
