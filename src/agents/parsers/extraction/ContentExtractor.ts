


export function extractFileContentFromDiff(lines: string[], startIndex: number, _filename: string): string | null {
  const contentLines: string[] = [];
  
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    
    
    if (line.startsWith('diff --git') || line.startsWith('--- a/')) {
      break;
    }
    
    
    if (line.startsWith('+')) {
      
      contentLines.push(line.substring(1));
    } else if (line.startsWith(' ')) {
      
      contentLines.push(line.substring(1));
    }
    
  }
  
  return contentLines.length > 0 ? contentLines.join('\n') : null;
}
