


import { getTransport } from "../transport/index.js";
import { cfg } from "../config.js";
import { PersonaConsumer } from "../personas/PersonaConsumer.js";

let consumer: PersonaConsumer | null = null;
let transport: any = null;
let isShuttingDown = false;

function printUsage() {
  console.log("Persona Worker Runner");
  console.log("");
  console.log("Usage:");
  console.log("  npm run dev");
  console.log("  npm run dev -- --consumer-id=worker-2");
  console.log("");
  console.log("Configuration (.env):");
  console.log("  TRANSPORT_TYPE=redis          Transport type (redis or local)");
  console.log("  ALLOWED_PERSONAS=persona1,... Personas this worker handles");
  console.log("  CONSUMER_ID=worker-1          Unique worker ID");
  console.log("  REDIS_URL=redis://...         Redis connection (if using redis transport)");
  console.log("");
  console.log("Examples:");
  console.log("  # Run all personas from ALLOWED_PERSONAS");
  console.log("  npm run dev");
  console.log("");
  console.log("  # Run with custom consumer ID");
  console.log("  CONSUMER_ID=worker-2 npm run dev");
  console.log("");
  console.log("  # Run specific personas (override ALLOWED_PERSONAS)");
  console.log("  ALLOWED_PERSONAS=context,lead-engineer npm run dev");
}

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('\n=== Shutting down ===');

  if (consumer) {
    console.log('Stopping persona consumer...');
    await consumer.stop();
    consumer = null;
  }

  if (transport) {
    console.log('Disconnecting transport...');
    try {
      await transport.quit();
    } catch (error) {
      console.error('Error disconnecting transport:', error);
    }
    transport = null;
  }

  console.log('Shutdown complete');
  process.exit(0);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  
  let consumerId = cfg.consumerId;
  for (const arg of args) {
    if (arg.startsWith('--consumer-id=')) {
      consumerId = arg.split('=')[1];
    }
  }

  console.log('=== Persona Worker Runner ===');
  console.log(`Transport: ${cfg.transportType}`);
  console.log(`Consumer ID: ${consumerId}`);
  console.log(`Personas: ${cfg.allowedPersonas.join(', ')}`);
  
  if (cfg.transportType === 'redis') {
    console.log(`Redis URL: ${cfg.redisUrl}`);
  }
  
  console.log('');

  
  if (cfg.allowedPersonas.length === 0) {
    console.error('ERROR: No personas configured in ALLOWED_PERSONAS');
    console.error('Set ALLOWED_PERSONAS in .env file (comma-separated list)');
    console.error('Example: ALLOWED_PERSONAS=context,lead-engineer,tester-qa');
    process.exit(1);
  }

  
  const personasWithoutModels = cfg.allowedPersonas.filter(p => !cfg.personaModels[p]);
  if (personasWithoutModels.length > 0) {
    console.warn('WARNING: Some personas have no model mapping:', personasWithoutModels.join(', '));
    console.warn('These personas will not be able to process requests');
    console.warn('Add model mappings in PERSONA_MODELS_JSON or .env');
  }

  
  console.log('Connecting to transport...');
  try {
    transport = await getTransport();
    console.log('✓ Transport connected');
  } catch (error: any) {
    console.error('✗ Failed to connect to transport:', error.message);
    process.exit(1);
  }

  
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  
  console.log('Starting persona consumer...');
  consumer = new PersonaConsumer(transport);

  try {
    await consumer.start({
      personas: cfg.allowedPersonas,
      consumerId
    });
    console.log('✓ Persona consumer started');
    console.log('');
    console.log('Waiting for persona requests...');
    console.log('Press Ctrl+C to stop');
    console.log('');

    
    await consumer.waitForCompletion();

  } catch (error: any) {
    console.error('✗ Failed to start persona consumer:', error.message);
    console.error(error.stack);
    await shutdown();
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
