import { parse as yamlParse } from 'yaml';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { WorkflowDefinition } from '../WorkflowEngine';


export class WorkflowLoader {
  private workflowDefinitions: Map<string, WorkflowDefinition>;
  private defaultWorkflowsLoaded = false;
  private stepRegistry: Map<string, new (...args: any[]) => any>;

  constructor(stepRegistry: Map<string, new (...args: any[]) => any>) {
    this.workflowDefinitions = new Map();
    this.stepRegistry = stepRegistry;
  }

  
  async ensureDefaultWorkflowsLoaded(): Promise<void> {
    if (this.defaultWorkflowsLoaded) return;
    
    const baseDir = process.cwd();
    const definitionsDir = join(baseDir, 'src', 'workflows', 'definitions');
    const subDir = join(baseDir, 'src', 'workflows', 'sub-workflows');
    
    try {
      await this.loadWorkflowsFromDirectory(definitionsDir);
    } catch {
      void 0;
    }
    
    try {
      await this.loadWorkflowsFromDirectory(subDir);
    } catch {
      void 0;
    }
    
    this.defaultWorkflowsLoaded = true;
  }

  
  async loadWorkflowFromFile(filePath: string): Promise<WorkflowDefinition> {
    try {
      const yamlContent = await readFile(filePath, 'utf-8');
      const definition = yamlParse(yamlContent) as WorkflowDefinition;
      
      this.validateWorkflowDefinition(definition);
      this.workflowDefinitions.set(definition.name, definition);
      
      return definition;
    } catch (error: any) {
      throw new Error(`Failed to load workflow from ${filePath}: ${error.message}`);
    }
  }

  
  async loadWorkflowsFromDirectory(directoryPath: string): Promise<WorkflowDefinition[]> {
    try {
      const files = await readdir(directoryPath);
      const yamlFiles = files
        .filter((file: string) => file.endsWith('.yaml') || file.endsWith('.yml'))
        .filter((file: string) => !/^test[-_.]/i.test(file));
      
      const definitions: WorkflowDefinition[] = [];
      
      for (const file of yamlFiles) {
        const filePath = join(directoryPath, file);
        try {
          const definition = await this.loadWorkflowFromFile(filePath);
          definitions.push(definition);
        } catch (error: any) {
          console.warn(`Failed to load workflow from ${file}: ${error.message}`);
        }
      }
      
      return definitions;
    } catch (error: any) {
      throw new Error(`Failed to load workflows from directory ${directoryPath}: ${error.message}`);
    }
  }

  
  getWorkflowDefinition(name: string): WorkflowDefinition | undefined {
    return this.workflowDefinitions.get(name);
  }

  
  getWorkflowDefinitions(): WorkflowDefinition[] {
    return Array.from(this.workflowDefinitions.values());
  }

  
  getWorkflowDefinitionsMap(): Map<string, WorkflowDefinition> {
    return this.workflowDefinitions;
  }

  
  private validateWorkflowDefinition(definition: WorkflowDefinition): void {
    if (!definition.name) {
      throw new Error('Workflow definition must have a name');
    }
    
    if (!definition.steps || definition.steps.length === 0) {
      throw new Error('Workflow definition must have at least one step');
    }
    
    
    for (const step of definition.steps) {
      const hasTemplate = !!(step as any).template;
      if (!hasTemplate && !this.stepRegistry.has(step.type)) {
        throw new Error(`Unknown step type '${step.type}' in step '${step.name}'`);
      }
    }
    
    
    const stepNames = new Set(definition.steps.map(s => s.name));
    for (const step of definition.steps) {
      if (step.depends_on) {
        for (const dependency of step.depends_on) {
          if (!stepNames.has(dependency)) {
            throw new Error(`Step '${step.name}' depends on unknown step '${dependency}'`);
          }
        }
      }
    }
  }
}
