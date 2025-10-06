# agent workflow planning

## High level workflow

- The coordinator agent should drive the integration of all other agents
    - it is reponsible for communicating with the project dashboard through the API to:
        - retreive and needed information (project, milestone, task, context)
        - create new items (milestones, tasks, bugs)
        - update status
    - it listens for responses of other agents and deliegates to the summariazer agent to clarify the next step prior to direct the next agent task

- an example of the basic happy path flow:
    - coordinator pulls the next milestone and task from the dashboard
    - assigns to the implementation-planner to create a plan
    - coordinator passes the plan to the summarizer for clarity
    - coordinator passes the summarized implementation plan to the engineer for execution
    - coordinator passes the engineering result to the qa agent
    - if the qa stage passes, cooridator forwards the engineering update to the code review agent
    - if the code review stage passes, cooridator forwards the code review update to the security agent
    - if the security stage passes, cooridator forwards the security update to the devops agent
    - if the devops stage passes (including merged PR), coordinator closes the inprogress task
    - this cycle repeats until no remaining milestones and tasks are found

- at each stage there are potential loops of iteration as described below

## Engineering implementation planning and approval flow
update to the lead-engineer and ui-engineer exection workflow to add a confirmation loop with the coordinator.
Example flow:
- coordinator provides context to implementation-planner agent with the taks of planning the execution
- implementation-planner responds with a plan of execution asking for confirmation from coordiator triggering a decision point:
    - if the plan aligns with the coordinators expectation then the coordinator send to the summarizer agent for concise instructions for the engineer to proceed
    - if not the coordinator revises the plan, prompt, or ensures missing files are added into the contex and asks the implementation-planner to update the plan
- this confirmation loop continues until approval or for an max set of attempts configurable by MAX_APPROVAL_RETRIES

## Helper agent task prioritization and hardining to project dashboard
for QA, Code-Review, Security agent, devOps agent responses the coordinator follows a mini process:
### QA and DevOps coordinator process
- coordinator reads the response, and gathers any needed logs from executed commands (example: npm test)
- coordinator sends these results to summarizer-agent to provide consise instructions
- coordinator uses the summarized result to add the required task to the dashboard api as tasks as children of the current task in the milestone
    - API speck is available here projects\openapi.yml  
- assigns the first sub-task accordingly (example: assigns tasks to fix linting in app.txs to implementation-planner to create a plan of exectuion for the lead-engineer)


### Code-Review and Security agent coordinator process
- coordinator reads the response, and gathers any needed logs from executed commands (example: npm test)
- coordinator sends these results to summarizer-agent to provide consise instructions
- coordinator uses the summarized result to the Project Manager agent to decide on when the tasks should be executed:
    - urgent - do as part of current task (create a child task)
    - high - do as part of the current milestone
    - medium - should map in an upcoming milestone
    - low - add to the milestone called Future Enhancements (create that milestone if it doesn't exist)
- read the PM response and adds the tasks into the project dashboard
- assigns the next task to the appropriate agent