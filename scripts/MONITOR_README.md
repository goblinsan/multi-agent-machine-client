# Redis Stream Monitor

A real-time monitoring tool for observing Redis Stream message interactions in the multi-agent system.

## Features

- 🔍 **Real-time monitoring** - Watch request and event streams as they happen
- 🎨 **Color-coded output** - Easy-to-read formatted messages with ANSI colors
- 📊 **Statistics tracking** - Automatic reporting every 30 seconds
- 🎯 **Flexible filtering** - Monitor specific streams or both
- 📝 **Verbose mode** - See detailed message payloads and metadata

## Usage

### Basic Monitoring (both streams)
```bash
npm run monitor
```

### Monitor Only Requests
```bash
npm run monitor requests
```

### Monitor Only Events
```bash
npm run monitor events
```

### Verbose Mode (shows all message details)
```bash
npm run monitor -- --verbose
npm run monitor requests -- -v
```

## Output Format

### Request Messages (REQ)
Shows messages sent to agents via the request stream:
```
HH:MM:SS.ms REQ workflow → from → to_persona [step] intent corr:123456
```

Fields:
- **Timestamp**: When the message was received
- **Workflow ID**: Last 8 chars of workflow_id (cyan)
- **From**: Source agent/service (yellow)
- **To**: Target persona (green)
- **Step**: Optional workflow step (magenta)
- **Intent**: What action is requested (bold)
- **Correlation ID**: Last 6 chars for tracking (gray)

### Event Messages (EVT)
Shows responses and status updates via the event stream:
```
HH:MM:SS.ms EVT workflow from_persona [step] ✓ DONE corr:123456
```

Status Icons:
- ✓ **DONE** (green): Task completed successfully
- ⋯ **PROGRESS** (blue): Task in progress
- ✗ **ERROR** (red): Task failed
- ⊗ **BLOCKED** (yellow): Task blocked

## Statistics

Every 30 seconds (and on exit), the monitor prints:
- Total requests processed
- Total events processed
- Total errors encountered
- Uptime duration

## Keyboard Shortcuts

- **Ctrl+C**: Gracefully shutdown and display final statistics

## Environment

The monitor uses the same Redis configuration as the main worker:
- Redis URL from `REDIS_URL` env var
- Redis password from `REDIS_PASSWORD` env var
- Request stream name from `REQUEST_STREAM` env var (default: `requests`)
- Event stream name from `EVENT_STREAM` env var (default: `events`)

Make sure your `.env` file is properly configured before running the monitor.

## Examples

### Debug a specific workflow
Run the monitor in one terminal, then trigger your workflow in another. Watch the message flow in real-time.

### Track error rates
Monitor events and watch for red ✗ ERROR messages. Errors automatically show additional details.

### Understand message timing
Use verbose mode to see message payloads and correlate requests with responses using correlation IDs.

## Tips

- Use verbose mode sparingly on busy systems (lots of output!)
- Pipe output to a file for later analysis: `npm run monitor > redis-monitor.log`
- Monitor only events when debugging coordinator logic
- Monitor only requests when debugging task routing
