import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { WorkflowStepConfig } from './WorkflowStep.js';

interface StepTemplate {
  type: string;
  outputs?: string[];
  config: Record<string, any>;
}

interface TemplateRegistry {
  templates: Record<string, StepTemplate>;
}

export class TemplateLoader {
  private templates: Map<string, StepTemplate> = new Map();
  private loaded = false;

  load(): void {
    if (this.loaded) return;

    const templatePath = join(process.cwd(), 'src/workflows/templates/step-templates.yaml');
    const content = readFileSync(templatePath, 'utf-8');
    const registry = parseYaml(content) as TemplateRegistry;

    for (const [name, template] of Object.entries(registry.templates)) {
      this.templates.set(name, template);
    }

    this.loaded = true;
  }

  getTemplate(name: string): StepTemplate | undefined {
    if (!this.loaded) this.load();
    return this.templates.get(name);
  }

  hasTemplate(name: string): boolean {
    if (!this.loaded) this.load();
    return this.templates.has(name);
  }

  expandTemplate(
    name: string,
    stepName: string,
    overrides?: Partial<WorkflowStepConfig>
  ): WorkflowStepConfig {
    const template = this.getTemplate(name);
    if (!template) {
      throw new Error(`Template not found: ${name}`);
    }

    const mergedConfig = this.deepMerge(template.config, overrides?.config || {});

    const result: WorkflowStepConfig = {
      name: stepName,
      type: template.type,
      outputs: template.outputs,
      config: mergedConfig
    };

    if (overrides) {
      if (overrides.depends_on) result.depends_on = overrides.depends_on;
      if (overrides.condition) result.condition = overrides.condition;
      if (overrides.description) result.description = overrides.description;
    }

    return result;
  }

  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
          result[key] = this.deepMerge(result[key], source[key]);
        } else {
          result[key] = source[key];
        }
      } else {
        result[key] = source[key];
      }
    }
    
    return result;
  }
}

export const templateLoader = new TemplateLoader();
