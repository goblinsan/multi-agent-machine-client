/**
 * Message Transport Examples
 * 
 * Demonstrates how to use the message transport abstraction
 * with both Redis and Local transports.
 */

import { getTransport, createTransport, getTransportType } from '../src/transport/index.js';
import { cfg } from '../src/config.js';

// =============================================================================
// Example 1: Using the Singleton (Recommended)
// =============================================================================

async function example1_Singleton() {
  console.log('Example 1: Singleton Pattern');
  console.log(`Transport type: ${getTransportType()}`);

  // Get or create singleton (auto-connects)
  const transport = await getTransport();

  // Create stream and consumer group
  await transport.xGroupCreate('my-stream', 'my-group', '0', { MKSTREAM: true });

  // Publish a message
  const messageId = await transport.xAdd('my-stream', '*', {
    task: 'process-order',
    orderId: '12345',
    timestamp: new Date().toISOString()
  });
  console.log(`Published message: ${messageId}`);

  // Read messages
  const messages = await transport.xReadGroup(
    'my-group',
    'worker-1',
    { key: 'my-stream', id: '>' },
    { COUNT: 10, BLOCK: 1000 }
  );

  if (messages) {
    for (const stream of Object.values(messages)) {
      for (const msg of stream.messages) {
        console.log(`Received message ${msg.id}:`, msg.fields);
        
        // Acknowledge
        await transport.xAck('my-stream', 'my-group', msg.id);
      }
    }
  }

  // Singleton remains connected for reuse
}

// =============================================================================
// Example 2: Creating Transport Directly
// =============================================================================

async function example2_Direct() {
  console.log('Example 2: Direct Creation');

  const transport = createTransport();
  await transport.connect();

  try {
    // Use transport
    await transport.xAdd('test-stream', '*', { data: 'hello' });
    console.log('Message published');
  } finally {
    // Must disconnect manually
    await transport.disconnect();
  }
}

// =============================================================================
// Example 3: Publishing Events (Similar to publishEvent helper)
// =============================================================================

async function example3_PublishEvent() {
  console.log('Example 3: Publishing Events');

  const transport = await getTransport();

  // Publish workflow event
  const eventId = await transport.xAdd(cfg.eventStream, '*', {
    workflow_id: 'wf-123',
    task_id: 'task-456',
    step: '3-implement',
    from_persona: 'lead-engineer',
    status: 'done',
    result: JSON.stringify({ files_modified: ['src/App.tsx'] }),
    corr_id: 'corr-789',
    ts: new Date().toISOString()
  });

  console.log(`Published event: ${eventId}`);
}

// =============================================================================
// Example 4: Consumer Group Pattern (Similar to worker.ts)
// =============================================================================

async function example4_ConsumerGroup() {
  console.log('Example 4: Consumer Group Pattern');

  const transport = await getTransport();
  const persona = 'lead-engineer';
  const group = `${cfg.groupPrefix}:${persona}`;
  const consumer = cfg.consumerId;

  // Ensure group exists
  try {
    await transport.xGroupCreate(cfg.requestStream, group, '0', { MKSTREAM: true });
  } catch (error: any) {
    if (!error.message?.includes('BUSYGROUP')) {
      throw error;
    }
    // Group already exists
  }

  // Read with blocking
  const result = await transport.xReadGroup(
    group,
    consumer,
    { key: cfg.requestStream, id: '>' },
    { COUNT: 1, BLOCK: 1000 }
  );

  if (result) {
    for (const stream of Object.values(result)) {
      for (const msg of stream.messages) {
        console.log(`Processing message ${msg.id} for ${persona}`);
        
        // Process the message
        await processMessage(transport, persona, msg.id, msg.fields);
      }
    }
  } else {
    console.log('No messages (timeout)');
  }
}

async function processMessage(
  transport: any,
  persona: string,
  messageId: string,
  fields: Record<string, string>
) {
  try {
    // Process the message
    console.log(`${persona} processing:`, fields);
    
    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Publish result
    await transport.xAdd(cfg.eventStream, '*', {
      workflow_id: fields.workflow_id,
      from_persona: persona,
      status: 'done',
      result: JSON.stringify({ success: true }),
      corr_id: fields.corr_id || '',
      ts: new Date().toISOString()
    });
    
    // Acknowledge
    await transport.xAck(cfg.requestStream, `${cfg.groupPrefix}:${persona}`, messageId);
    console.log(`Message ${messageId} acknowledged`);
    
  } catch (error) {
    console.error('Error processing message:', error);
    
    // Publish error event
    await transport.xAdd(cfg.eventStream, '*', {
      workflow_id: fields.workflow_id,
      from_persona: persona,
      status: 'error',
      error: String(error),
      corr_id: fields.corr_id || '',
      ts: new Date().toISOString()
    });
  }
}

// =============================================================================
// Example 5: Switching Transports via Environment
// =============================================================================

async function example5_TransportSwitching() {
  console.log('Example 5: Transport Switching');
  
  // Current transport
  console.log(`Current transport: ${getTransportType()}`);
  
  // To switch, set environment variable and restart:
  // TRANSPORT_TYPE=local npm start   (for local development)
  // TRANSPORT_TYPE=redis npm start   (for production)
  
  const transport = await getTransport();
  
  // Same code works with both transports!
  await transport.xAdd('demo-stream', '*', { message: 'works with any transport' });
  console.log('Message published (regardless of transport)');
}

// =============================================================================
// Example 6: Reading from Multiple Streams
// =============================================================================

async function example6_MultipleStreams() {
  console.log('Example 6: Multiple Streams');

  const transport = await getTransport();

  // Read from multiple streams
  const result = await transport.xRead(
    [
      { key: 'stream-1', id: '0' },
      { key: 'stream-2', id: '0' }
    ],
    { COUNT: 10, BLOCK: 1000 }
  );

  if (result) {
    for (const [streamKey, stream] of Object.entries(result)) {
      console.log(`Stream ${streamKey}: ${stream.messages.length} messages`);
      for (const msg of stream.messages) {
        console.log(`  ${msg.id}:`, msg.fields);
      }
    }
  }
}

// =============================================================================
// Example 7: Stream Management
// =============================================================================

async function example7_StreamManagement() {
  console.log('Example 7: Stream Management');

  const transport = await getTransport();
  const streamName = 'temp-stream';

  // Create stream with message
  await transport.xAdd(streamName, '*', { data: 'test' });

  // Get stream length
  const length = await transport.xLen(streamName);
  console.log(`Stream length: ${length}`);

  // Get consumer groups
  try {
    await transport.xGroupCreate(streamName, 'test-group', '0');
    const groups = await transport.xInfoGroups(streamName);
    console.log('Consumer groups:', groups);
  } catch (error: any) {
    if (!error.message?.includes('BUSYGROUP')) {
      throw error;
    }
  }

  // Delete stream
  const deleted = await transport.del(streamName);
  console.log(`Stream deleted: ${deleted === 1}`);
}

// =============================================================================
// Run Examples
// =============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('Message Transport Examples');
  console.log('='.repeat(80));
  console.log();

  try {
    // Run examples
    await example1_Singleton();
    console.log();
    
    await example2_Direct();
    console.log();
    
    await example3_PublishEvent();
    console.log();
    
    await example4_ConsumerGroup();
    console.log();
    
    await example5_TransportSwitching();
    console.log();
    
    await example6_MultipleStreams();
    console.log();
    
    await example7_StreamManagement();
    console.log();
    
    console.log('='.repeat(80));
    console.log('All examples completed!');
    console.log('='.repeat(80));
    
  } catch (error) {
    console.error('Error running examples:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export {
  example1_Singleton,
  example2_Direct,
  example3_PublishEvent,
  example4_ConsumerGroup,
  example5_TransportSwitching,
  example6_MultipleStreams,
  example7_StreamManagement
};
