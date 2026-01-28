# Issue Reporting Guide

## Before Filing an Issue

Please ensure you're filing the issue in the correct repository:

### This Repository (multi-agent-machine-client / redis-machine-client)
This is a multi-agent machine client for managing distributed workflows and task coordination.

**Technologies used:**
- TypeScript
- Redis Streams / EventEmitter
- Vitest for testing
- Local LM Studio integration

**This repository does NOT contain:**
- Google Cloud Functions
- Database services using Drizzle ORM or Neon
- API services
- Palette/color management services

### If Your Error Mentions:
- `kulrs-api` → File issue at https://github.com/goblinsan/kulrs
- Google Cloud Functions deployment → Check the repository that contains the function
- `@kulrs/db` package → File issue at https://github.com/goblinsan/kulrs
- Drizzle ORM or Neon database errors → Check your API repository

## Common Deployment Issues

### Google Cloud Functions Build Failures

If you see errors like:
```
ERROR: Cannot find module '@package/name'
```

During GCF deployment, common causes include:

1. **Missing dependencies in node_modules during build**
   - Ensure `package.json` lists all dependencies
   - Check that `.gcloudignore` isn't excluding necessary files

2. **Incorrect `.gcloudignore` configuration**
   - Ensure `.gcloudignore` doesn't exclude `package.json` or `package-lock.json`
   - Don't exclude source files or build configuration needed during deployment
   - Generally, `node_modules` should be excluded and rebuilt during GCF build process

3. **TypeScript compilation issues**
   - Ensure `tsconfig.json` is properly configured
   - Check that all type declaration files are available

## Getting Help

1. Verify you're in the correct repository
2. Check existing issues for similar problems
3. Provide full error logs and context
4. Include your environment and configuration details
