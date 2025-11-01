import { readFileSync } from "fs";
import { resolve } from "path";

interface Project {
  name: string;
  slug: string;
  description: string;
}

interface Milestone {
  name: string;
  slug: string;
  status: string;
  description: string;
}

interface Task {
  title: string;
  description: string;
  status: string;
  labels: string[];
}

interface ProjectData {
  project: Project;
  milestones: Milestone[];
  tasks: Record<string, Task[]>;
}

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function createProject(project: Project): Promise<number> {
  console.log("\n📝 Creating project...");

  const response = await fetch(`${BASE_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(project),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create project: ${error}`);
  }

  const result = await response.json();
  console.log(`  ✓ Project created: ${project.name} (ID: ${result.id})`);

  return result.id;
}

async function createMilestone(
  projectId: number,
  milestone: Milestone,
): Promise<{ id: number; slug: string }> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/milestones`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(milestone),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create milestone ${milestone.name}: ${error}`);
  }

  const result = await response.json();
  return { id: result.id, slug: milestone.slug };
}

async function createTasksInBulk(
  projectId: number,
  milestoneId: number,
  tasks: Task[],
): Promise<{ created: number; skipped: number }> {
  const tasksWithMilestone = tasks.map((task) => ({
    ...task,
    milestone_id: milestoneId,
  }));

  const response = await fetch(`${BASE_URL}/projects/${projectId}/tasks:bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tasks: tasksWithMilestone }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create tasks in bulk: ${error}`);
  }

  const result = await response.json();
  return {
    created: result.summary.created,
    skipped: result.summary.skipped,
  };
}

async function setupProject(data: ProjectData) {
  console.log("========================================");
  console.log("Dashboard API - Project Setup");
  console.log("========================================");
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Project: ${data.project.name}`);
  console.log("");

  try {
    const projectId = await createProject(data.project);

    console.log("\n🎯 Creating milestones...");
    const milestoneMap = new Map<string, number>();

    for (let i = 0; i < data.milestones.length; i++) {
      const milestone = data.milestones[i];
      const { id, slug } = await createMilestone(projectId, milestone);
      milestoneMap.set(slug, id);
      console.log(
        `  ✓ Milestone ${i + 1}/${data.milestones.length}: ${milestone.name} (ID: ${id})`,
      );
    }

    console.log("\n📋 Creating tasks in bulk...");
    let totalTasksCreated = 0;

    for (const [milestoneSlug, milestoneId] of milestoneMap.entries()) {
      const tasks = data.tasks[milestoneSlug];

      if (!tasks || tasks.length === 0) {
        console.log(`  ⚠ No tasks defined for milestone: ${milestoneSlug}`);
        continue;
      }

      const { created, skipped } = await createTasksInBulk(
        projectId,
        milestoneId,
        tasks,
      );
      totalTasksCreated += created;

      console.log(
        `  ✓ Milestone ${milestoneSlug}: Created ${created} tasks, Skipped ${skipped} duplicates`,
      );
    }

    console.log("\n========================================");
    console.log("✓ Project Setup Complete!");
    console.log("========================================");
    console.log("");
    console.log(`Project ID: ${projectId}`);
    console.log(`Project Name: ${data.project.name}`);
    console.log(`Project Slug: ${data.project.slug}`);
    console.log(`Milestones Created: ${milestoneMap.size}`);
    console.log(`Total Tasks Created: ${totalTasksCreated}`);
    console.log("");
    console.log("Next Steps:");
    console.log(`  1. View project: ${BASE_URL}/projects/${projectId}`);
    console.log(`  2. List tasks: ${BASE_URL}/projects/${projectId}/tasks`);
    console.log(`  3. Start workflow to process tasks`);
    console.log("");
  } catch (error) {
    console.error("\n❌ Error during project setup:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function loadProjectData(filePath?: string): ProjectData {
  let jsonContent: string;

  if (!filePath || filePath === "-") {
    console.log("📥 Reading project data from stdin...");
    jsonContent = readFileSync(0, "utf-8");
  } else {
    const resolvedPath = resolve(filePath);
    console.log(`📥 Reading project data from: ${resolvedPath}`);
    jsonContent = readFileSync(resolvedPath, "utf-8");
  }

  try {
    return JSON.parse(jsonContent) as ProjectData;
  } catch (error) {
    console.error("❌ Error parsing JSON:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args[0] || "./examples/project-setup-example.json";

  const projectData = loadProjectData(filePath === "-" ? "-" : filePath);

  await setupProject(projectData);
}

main().catch((error) => {
  console.error("❌ Fatal error:");
  console.error(error);
  process.exit(1);
});
