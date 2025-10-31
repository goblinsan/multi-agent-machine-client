/**
 * MessageFormatter - Formats messages for the event stream
 * 
 * Responsibilities:
 * - Format successful persona responses
 * - Format error responses
 * - Standardize message structure
 */
export class MessageFormatter {
  /**
   * Format a successful persona response for the event stream
   */
  formatSuccessResponse(params: {
    workflowId: string;
    persona: string;
    corrId: string;
    step: string;
    result: any;
    durationMs: number;
  }): Record<string, string> {
    const { workflowId, persona, corrId, step, result, durationMs } = params;

    return {
      workflow_id: workflowId,
      from_persona: persona,
      status: 'done',
      corr_id: corrId,
      step: step,
      result: JSON.stringify(result),
      duration_ms: String(durationMs)
    };
  }

  /**
   * Format an error response for the event stream
   */
  formatErrorResponse(params: {
    workflowId: string;
    persona: string;
    corrId: string;
    step: string;
    error: Error | string;
    durationMs: number;
  }): Record<string, string> {
    const { workflowId, persona, corrId, step, error, durationMs } = params;

    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      workflow_id: workflowId,
      from_persona: persona,
      status: 'done',
      corr_id: corrId,
      step: step,
      result: JSON.stringify({
        status: 'fail',
        error: errorMessage,
        details: 'Persona execution failed - check logs for details'
      }),
      duration_ms: String(durationMs)
    };
  }
}
