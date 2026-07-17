export interface Mutant {
  file: string;
  line: number;
  operator: string;
  original: string;
  mutated: string;
  text: string;
}

interface Operator {
  id: string;
  pattern: RegExp;
  replace: (match: string) => string;
}

const OPERATORS: Operator[] = [
  { id: "equality", pattern: /===/g, replace: () => "!==" },
  { id: "inequality", pattern: /!==/g, replace: () => "===" },
  { id: "logical_and", pattern: /&&/g, replace: () => "||" },
  { id: "logical_or", pattern: /\|\|/g, replace: () => "&&" },
  { id: "boolean_true", pattern: /\btrue\b/g, replace: () => "false" },
  { id: "boolean_false", pattern: /\bfalse\b/g, replace: () => "true" },
  { id: "boundary_gte", pattern: / >= /g, replace: () => " > " },
  { id: "boundary_lte", pattern: / <= /g, replace: () => " < " },
  { id: "boundary_gt", pattern: / > /g, replace: () => " >= " },
  { id: "boundary_lt", pattern: / < /g, replace: () => " <= " },
];

const SKIP_LINE = /^\s*(?:\/\/|\*|\/\*)/;

function isInsideImport(line: string): boolean {
  return /^\s*import\b|^\s*export\s+.*\bfrom\b/.test(line);
}

export function generateMutants(file: string, source: string, cap: number): Mutant[] {
  const lines = source.split("\n");
  const mutants: Mutant[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || SKIP_LINE.test(line) || isInsideImport(line)) continue;

    for (const operator of OPERATORS) {
      operator.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = operator.pattern.exec(line)) !== null) {
        const start = match.index;
        const replacement = operator.replace(match[0]);
        const mutatedLine =
          line.slice(0, start) + replacement + line.slice(start + match[0].length);
        if (mutatedLine === line) continue;

        const mutatedLines = lines.slice();
        mutatedLines[index] = mutatedLine;

        mutants.push({
          file,
          line: index + 1,
          operator: operator.id,
          original: line.trim(),
          mutated: mutatedLine.trim(),
          text: mutatedLines.join("\n"),
        });
      }
    }
  }

  mutants.sort((a, b) =>
    a.line !== b.line ? a.line - b.line : a.operator.localeCompare(b.operator),
  );

  if (mutants.length <= cap) return mutants;

  const stride = mutants.length / cap;
  const sampled: Mutant[] = [];
  for (let i = 0; i < cap; i++) {
    sampled.push(mutants[Math.floor(i * stride)]);
  }
  return sampled;
}
