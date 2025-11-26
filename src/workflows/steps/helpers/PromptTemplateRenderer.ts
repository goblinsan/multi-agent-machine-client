import fs from "fs/promises";
import path from "path";
import Handlebars from "handlebars";
import { logger } from "../../../logger.js";

export class PromptTemplateRenderer {
  private static compiled = new Map<string, Handlebars.TemplateDelegate>();
  private static registered = false;

  static async render(
    templatePath: string,
    data: Record<string, any>,
  ): Promise<string> {
    this.ensureHelpers();
    const fullPath = this.resolvePath(templatePath);

    try {
      let template = this.compiled.get(fullPath);
      if (!template) {
        const raw = await fs.readFile(fullPath, "utf-8");
        template = Handlebars.compile(raw);
        this.compiled.set(fullPath, template);
      }
      return template(data);
    } catch (error) {
      logger.error("PromptTemplateRenderer: failed to render template", {
        templatePath,
        fullPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private static ensureHelpers(): void {
    if (this.registered) return;
    Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
    Handlebars.registerHelper("and", (a: any, b: any) => !!a && !!b);
    Handlebars.registerHelper("or", (a: any, b: any) => !!a || !!b);
    Handlebars.registerHelper("json", (value: any, spaces = 2) => {
      try {
        const text = JSON.stringify(value, null, Number(spaces) || 2);
        return new Handlebars.SafeString(text ?? "null");
      } catch (_error) {
        return new Handlebars.SafeString("null");
      }
    });
    this.registered = true;
  }

  private static resolvePath(templatePath: string): string {
    if (path.isAbsolute(templatePath)) {
      return templatePath;
    }
    const baseDir = path.resolve(process.cwd(), "src", "workflows");
    return path.resolve(baseDir, templatePath);
  }
}
