#!/bin/bash
# Quick test script to demonstrate the Redis monitor

echo "Redis Stream Monitor Test"
echo "========================="
echo ""
echo "Available commands:"
echo ""
echo "  npm run monitor              # Monitor both streams"
echo "  npm run monitor requests     # Monitor only requests"
echo "  npm run monitor events       # Monitor only events"
echo "  npm run monitor -- --verbose # Verbose mode (all streams)"
echo ""
echo "To test, run the monitor in one terminal, then:"
echo "  npm run seed                 # Send test messages"
echo ""
echo "Make sure Redis is running and .env is configured!"
echo ""
echo "Press any key to start monitoring (Ctrl+C to stop)..."
read -n 1 -s

npm run monitor
