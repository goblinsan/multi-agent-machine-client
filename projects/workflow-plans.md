# Next workflow refinement steps

## Engineering implementation planning and approval flow
update to the lead-engineer and ui-engineer exection workflow to add a confirmation loop with the coordinator.
Example flow:
- coordinator provides context to engineer agent with the taks of planning the execution
- engineer responds with a plan of execution asking for confirmation from coordiator
- if the plan aligns with the coordinators expectation then the coordinator approves for the engineer to proceed
- if not the coordinator revises the plan, prompt, or ensures missing files are added into the contex and asks the engineer to update the plan
- this confirmation loop continues until approval or for an max set of attempts configurable by MAX_APPROVAL_RETRIES

## Helper agent task prioritization and hardining to project dashboard
for QA, Code-Review, Security agent, devOps agent responses the coordinator follows a mini process:
### QA and DevOps coordinator process
- reads the response, and gathers any needed logs from executed commands
- adds any actions required to the dashboard api as tasks as children of the current task in the milestone
- sample api call
    curl -X POST http://localhost:8080/v1/tasks \
    -H "Content-Type: application/json" \
    -d '{
        "milestone_id": "11111111-1111-1111-1111-111111111111",
        "parent_task_id": "22222222-2222-2222-2222-222222222222",
        "title": "Child task title",
        "description": "Work item as a child of another task",
        "effort_estimate": 3,
        "priority_score": 5
    }'
- assigns the first sub-task accornding (example: assigns tasks to fix linting in app.txs to lead-engineer)


### Code-Review and Security agent coordinator process
- reads the response and organizes into discreet exectubale tasks
- sends an request to the Project Manager agent to decide on when the tasks should be executed:
--- urgent - do as part of current task (create a child task)
--- high - do as part of the current milestone
--- medium - should map in an upcoming milestone
--- low - add to the milestone called Future Enhancements (create that milestone if it doesn't exist)
- read the PM response and adds the tasks into the project dashboard
- assigns the next task to the appropriate agent