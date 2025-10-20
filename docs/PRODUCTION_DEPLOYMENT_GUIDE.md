# Production Deployment Guide - Dashboard Backend

**Version:** 1.0.0  
**Last Updated:** October 20, 2025  
**Service:** Dashboard Backend API

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Environment Variables](#environment-variables)
4. [Deployment Options](#deployment-options)
5. [Health Check Configuration](#health-check-configuration)
6. [Metrics & Monitoring](#metrics--monitoring)
7. [Security Best Practices](#security-best-practices)
8. [Performance Baselines](#performance-baselines)
9. [Troubleshooting](#troubleshooting)
10. [Rollback Procedures](#rollback-procedures)

---

## Overview

The Dashboard Backend is a self-contained Fastify + SQLite API service that provides task and project management for the multi-agent machine client system.

**Key Characteristics:**
- **Runtime:** Node.js 18+
- **Framework:** Fastify 4.x
- **Database:** SQLite (sql.js WASM)
- **Port:** 3000 (configurable via `PORT` env var)
- **Memory:** ~50MB base + database size
- **CPU:** Minimal (<5% under normal load)

**Production Features:**
- ✅ Health check endpoints
- ✅ Prometheus metrics
- ✅ Graceful shutdown
- ✅ Request logging
- ✅ Error handling
- ✅ Database persistence

---

## Prerequisites

### Required

- **Node.js:** Version 18.x or higher
- **npm:** Version 8.x or higher
- **Memory:** Minimum 512MB RAM
- **Disk:** Minimum 100MB (database grows with usage)
- **Network:** Port 3000 must be available (or custom port)

### Optional

- **Docker:** For containerized deployment
- **Kubernetes:** For orchestrated deployment
- **Prometheus:** For metrics collection
- **Grafana:** For metrics visualization
- **Load Balancer:** For high availability

---

## Environment Variables

### Required

None - the service runs with sensible defaults.

### Optional

| Variable | Default | Description | Example |
|----------|---------|-------------|---------|
| `PORT` | `3000` | HTTP server port | `8080` |
| `HOST` | `0.0.0.0` | Server bind address | `127.0.0.1` |
| `DATABASE_PATH` | `./data/dashboard.db` | SQLite database file path | `/var/data/dashboard.db` |
| `LOG_LEVEL` | `info` | Fastify log level | `debug`, `warn`, `error` |
| `NODE_ENV` | `production` | Node environment | `production`, `development` |
| `npm_package_version` | `1.0.0` | Service version (auto-set) | `1.2.3` |

### Example Configuration

**Development:**
```bash
export PORT=3000
export LOG_LEVEL=debug
export NODE_ENV=development
export DATABASE_PATH=./dev-data/dashboard.db
```

**Production:**
```bash
export PORT=3000
export LOG_LEVEL=info
export NODE_ENV=production
export DATABASE_PATH=/var/lib/dashboard/dashboard.db
```

**Docker:**
```dockerfile
ENV PORT=3000
ENV LOG_LEVEL=info
ENV NODE_ENV=production
ENV DATABASE_PATH=/data/dashboard.db
```

---

## Deployment Options

### Option 1: Standalone Server

**Build:**
```bash
cd src/dashboard-backend
npm install --production
npm run build
```

**Run:**
```bash
npm start
# or
node dist/server.js
```

**Process Manager (PM2):**
```bash
npm install -g pm2
pm2 start dist/server.js --name dashboard-backend
pm2 save
pm2 startup
```

**Systemd Service:**
```ini
# /etc/systemd/system/dashboard-backend.service
[Unit]
Description=Dashboard Backend API
After=network.target

[Service]
Type=simple
User=dashboard
WorkingDirectory=/opt/dashboard-backend
ExecStart=/usr/bin/node /opt/dashboard-backend/dist/server.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dashboard-backend

Environment=NODE_ENV=production
Environment=PORT=3000
Environment=DATABASE_PATH=/var/lib/dashboard/dashboard.db

[Install]
WantedBy=multi-user.target
```

**Start Service:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable dashboard-backend
sudo systemctl start dashboard-backend
sudo systemctl status dashboard-backend
```

### Option 2: Docker Container

**Dockerfile:**
```dockerfile
FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /data && chown -R node:node /data

# Switch to non-root user
USER node

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"

# Run server
CMD ["node", "dist/server.js"]
```

**Build:**
```bash
docker build -t dashboard-backend:latest .
```

**Run:**
```bash
docker run -d \
  --name dashboard-backend \
  -p 3000:3000 \
  -v /var/lib/dashboard:/data \
  -e DATABASE_PATH=/data/dashboard.db \
  -e LOG_LEVEL=info \
  --restart unless-stopped \
  dashboard-backend:latest
```

**Docker Compose:**
```yaml
version: '3.8'

services:
  dashboard-backend:
    image: dashboard-backend:latest
    container_name: dashboard-backend
    ports:
      - "3000:3000"
    volumes:
      - dashboard-data:/data
    environment:
      - NODE_ENV=production
      - PORT=3000
      - DATABASE_PATH=/data/dashboard.db
      - LOG_LEVEL=info
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); })"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  dashboard-data:
    driver: local
```

### Option 3: Kubernetes Deployment

**Deployment YAML:**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: dashboard-backend
  namespace: default
  labels:
    app: dashboard-backend
    version: v1.0.0
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: dashboard-backend
  template:
    metadata:
      labels:
        app: dashboard-backend
        version: v1.0.0
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      containers:
      - name: dashboard-backend
        image: dashboard-backend:1.0.0
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: 3000
          protocol: TCP
        env:
        - name: NODE_ENV
          value: "production"
        - name: PORT
          value: "3000"
        - name: LOG_LEVEL
          value: "info"
        - name: DATABASE_PATH
          value: "/data/dashboard.db"
        volumeMounts:
        - name: data
          mountPath: /data
        resources:
          requests:
            memory: "128Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
          timeoutSeconds: 5
          successThreshold: 1
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
          timeoutSeconds: 3
          successThreshold: 1
          failureThreshold: 2
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]
      volumes:
      - name: data
        persistentVolumeClaim:
          claimName: dashboard-backend-pvc
      terminationGracePeriodSeconds: 30
---
apiVersion: v1
kind: Service
metadata:
  name: dashboard-backend
  namespace: default
  labels:
    app: dashboard-backend
spec:
  type: ClusterIP
  ports:
  - name: http
    port: 3000
    targetPort: 3000
    protocol: TCP
  selector:
    app: dashboard-backend
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: dashboard-backend-pvc
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: standard
```

**Apply:**
```bash
kubectl apply -f dashboard-backend.yaml
kubectl rollout status deployment/dashboard-backend
kubectl get pods -l app=dashboard-backend
```

---

## Health Check Configuration

### Endpoints

| Endpoint | Purpose | Expected Response | Timeout |
|----------|---------|------------------|---------|
| `GET /health` | Basic availability | `{"status": "ok"}` | 1s |
| `GET /health/db` | Database connectivity | `{"status": "ok", "database": "connected"}` | 5s |
| `GET /health/ready` | Kubernetes readiness | `{"status": "ready"}` | 3s |
| `GET /health/live` | Kubernetes liveness | `{"status": "alive"}` | 3s |

### Load Balancer Configuration

**NGINX:**
```nginx
upstream dashboard_backend {
    server 127.0.0.1:3000 max_fails=3 fail_timeout=30s;
    
    # Add more servers for HA
    # server 127.0.0.1:3001 max_fails=3 fail_timeout=30s;
    # server 127.0.0.1:3002 max_fails=3 fail_timeout=30s;
}

server {
    listen 80;
    server_name dashboard.example.com;
    
    location / {
        proxy_pass http://dashboard_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Health check
        proxy_next_upstream error timeout http_500 http_502 http_503;
    }
    
    location /health {
        proxy_pass http://dashboard_backend/health;
        access_log off;
    }
}
```

**HAProxy:**
```
backend dashboard_backend
    mode http
    balance roundrobin
    option httpchk GET /health
    http-check expect status 200
    
    server dashboard1 127.0.0.1:3000 check inter 5s fall 3 rise 2
    # server dashboard2 127.0.0.1:3001 check inter 5s fall 3 rise 2
    # server dashboard3 127.0.0.1:3002 check inter 5s fall 3 rise 2
```

**AWS ALB Target Group:**
```json
{
  "HealthCheckEnabled": true,
  "HealthCheckProtocol": "HTTP",
  "HealthCheckPath": "/health",
  "HealthCheckIntervalSeconds": 30,
  "HealthCheckTimeoutSeconds": 5,
  "HealthyThresholdCount": 2,
  "UnhealthyThresholdCount": 3,
  "Matcher": {
    "HttpCode": "200"
  }
}
```

### Kubernetes Probe Configuration

**Best Practices:**
- **Liveness Probe:** Detects deadlocks and unresponsive pods
  - Use `/health/live`
  - Higher `failureThreshold` (3+) to avoid false positives
  - Longer `periodSeconds` (10s+)

- **Readiness Probe:** Prevents traffic to unhealthy pods
  - Use `/health/ready`
  - Lower `failureThreshold` (2) for faster detection
  - Shorter `periodSeconds` (5s)

- **Startup Probe:** Handles slow-starting containers
  - Use `/health` or `/health/ready`
  - High `failureThreshold` (30) × `periodSeconds` (5s) = 150s timeout

**Example:**
```yaml
startupProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 0
  periodSeconds: 5
  failureThreshold: 30  # 150s total

livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 2
```

---

## Metrics & Monitoring

### Prometheus Configuration

**Scrape Config:**
```yaml
scrape_configs:
  - job_name: 'dashboard-backend'
    scrape_interval: 15s
    scrape_timeout: 10s
    metrics_path: '/metrics'
    static_configs:
      - targets: ['dashboard-backend:3000']
        labels:
          service: 'dashboard-backend'
          environment: 'production'
```

**Service Discovery (Kubernetes):**
```yaml
scrape_configs:
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
    - role: pod
    relabel_configs:
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
      action: keep
      regex: true
    - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
      action: replace
      target_label: __metrics_path__
      regex: (.+)
    - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
      action: replace
      regex: ([^:]+)(?::\d+)?;(\d+)
      replacement: $1:$2
      target_label: __address__
```

### Available Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `http_requests_total` | Counter | Total HTTP requests | `service="dashboard-backend"` |
| `http_errors_total` | Counter | Total HTTP errors (4xx/5xx) | `service="dashboard-backend"` |
| `tasks_created_total` | Counter | Total tasks created | `service="dashboard-backend"` |
| `tasks_updated_total` | Counter | Total tasks updated | `service="dashboard-backend"` |
| `db_queries_total` | Counter | Total database queries | `service="dashboard-backend"` |
| `uptime_seconds` | Gauge | Service uptime in seconds | `service="dashboard-backend"` |

### Grafana Dashboard

**JSON Model:** (Import via Grafana UI)
```json
{
  "dashboard": {
    "title": "Dashboard Backend Metrics",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [{
          "expr": "rate(http_requests_total{service=\"dashboard-backend\"}[5m])"
        }],
        "type": "graph"
      },
      {
        "title": "Error Rate",
        "targets": [{
          "expr": "rate(http_errors_total{service=\"dashboard-backend\"}[5m])"
        }],
        "type": "graph"
      },
      {
        "title": "Error Percentage",
        "targets": [{
          "expr": "100 * (rate(http_errors_total{service=\"dashboard-backend\"}[5m]) / rate(http_requests_total{service=\"dashboard-backend\"}[5m]))"
        }],
        "type": "graph"
      },
      {
        "title": "Tasks Created",
        "targets": [{
          "expr": "tasks_created_total{service=\"dashboard-backend\"}"
        }],
        "type": "stat"
      },
      {
        "title": "Database Queries",
        "targets": [{
          "expr": "rate(db_queries_total{service=\"dashboard-backend\"}[5m])"
        }],
        "type": "graph"
      },
      {
        "title": "Uptime",
        "targets": [{
          "expr": "uptime_seconds{service=\"dashboard-backend\"}"
        }],
        "type": "stat"
      }
    ]
  }
}
```

**Key Queries:**
```promql
# Request rate (requests per second)
rate(http_requests_total{service="dashboard-backend"}[5m])

# Error rate (errors per second)
rate(http_errors_total{service="dashboard-backend"}[5m])

# Error percentage
100 * (
  rate(http_errors_total{service="dashboard-backend"}[5m]) / 
  rate(http_requests_total{service="dashboard-backend"}[5m])
)

# P95 request latency (requires histogram metrics - future enhancement)
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# Database query rate
rate(db_queries_total{service="dashboard-backend"}[5m])

# Task creation rate
rate(tasks_created_total{service="dashboard-backend"}[5m])
```

### Alerting Rules

**Prometheus Alerts:**
```yaml
groups:
  - name: dashboard-backend
    interval: 30s
    rules:
      # High error rate
      - alert: DashboardBackendHighErrorRate
        expr: |
          100 * (
            rate(http_errors_total{service="dashboard-backend"}[5m]) / 
            rate(http_requests_total{service="dashboard-backend"}[5m])
          ) > 5
        for: 5m
        labels:
          severity: warning
          service: dashboard-backend
        annotations:
          summary: "High error rate ({{ $value }}%)"
          description: "Dashboard backend error rate is {{ $value }}% (threshold: 5%)"
      
      # Service down
      - alert: DashboardBackendDown
        expr: up{job="dashboard-backend"} == 0
        for: 1m
        labels:
          severity: critical
          service: dashboard-backend
        annotations:
          summary: "Service is down"
          description: "Dashboard backend is not responding to health checks"
      
      # High memory usage (requires node_exporter)
      - alert: DashboardBackendHighMemory
        expr: |
          process_resident_memory_bytes{job="dashboard-backend"} / 
          (1024 * 1024) > 500
        for: 5m
        labels:
          severity: warning
          service: dashboard-backend
        annotations:
          summary: "High memory usage ({{ $value }}MB)"
          description: "Dashboard backend is using {{ $value }}MB RAM (threshold: 500MB)"
```

---

## Security Best Practices

### Network Security

1. **Firewall Rules:**
   ```bash
   # Allow port 3000 from load balancer only
   sudo ufw allow from 10.0.0.0/8 to any port 3000
   
   # Or use iptables
   sudo iptables -A INPUT -p tcp --dport 3000 -s 10.0.0.0/8 -j ACCEPT
   sudo iptables -A INPUT -p tcp --dport 3000 -j DROP
   ```

2. **Reverse Proxy:**
   - Always run behind NGINX/HAProxy in production
   - Terminate TLS at reverse proxy
   - Add rate limiting at proxy layer

3. **Network Policies (Kubernetes):**
   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: dashboard-backend-policy
   spec:
     podSelector:
       matchLabels:
         app: dashboard-backend
     policyTypes:
     - Ingress
     ingress:
     - from:
       - podSelector:
           matchLabels:
             role: load-balancer
       ports:
       - protocol: TCP
         port: 3000
   ```

### Application Security

1. **Authentication:**
   - Current: No auth on health/metrics endpoints (by design)
   - Task endpoints: Add API key validation (future enhancement)
   - Example:
     ```typescript
     fastify.addHook('onRequest', async (request, reply) => {
       if (request.url.startsWith('/health') || request.url.startsWith('/metrics')) {
         return; // Skip auth for monitoring
       }
       
       const apiKey = request.headers['authorization'];
       if (!apiKey || !validateApiKey(apiKey)) {
         return reply.code(401).send({ error: 'Unauthorized' });
       }
     });
     ```

2. **Rate Limiting:**
   ```typescript
   import rateLimit from '@fastify/rate-limit';
   
   fastify.register(rateLimit, {
     max: 100,
     timeWindow: '1 minute'
   });
   ```

3. **CORS:**
   ```typescript
   import cors from '@fastify/cors';
   
   fastify.register(cors, {
     origin: ['https://dashboard.example.com'],
     credentials: true
   });
   ```

4. **Input Validation:**
   - Already using Zod for request validation
   - Prevents SQL injection (parameterized queries)
   - Prevents XSS (JSON responses only)

### File System Security

1. **Database File Permissions:**
   ```bash
   chmod 600 /var/lib/dashboard/dashboard.db
   chown dashboard:dashboard /var/lib/dashboard/dashboard.db
   ```

2. **Run as Non-Root:**
   ```dockerfile
   # In Dockerfile
   USER node
   ```
   
   ```bash
   # In systemd
   User=dashboard
   ```

3. **Read-Only Root Filesystem (Kubernetes):**
   ```yaml
   securityContext:
     runAsNonRoot: true
     runAsUser: 1000
     readOnlyRootFilesystem: true
   ```

---

## Performance Baselines

### Expected Performance

**Hardware:** 2 vCPU, 2GB RAM, SSD storage

| Metric | Baseline | Threshold | Notes |
|--------|----------|-----------|-------|
| Request Latency (P50) | <5ms | <10ms | For simple GET requests |
| Request Latency (P95) | <20ms | <50ms | For complex queries |
| Request Latency (P99) | <50ms | <100ms | Including database queries |
| Throughput | 1000 req/s | 500 req/s | Per instance |
| Memory Usage (Idle) | ~50MB | <100MB | Base memory footprint |
| Memory Usage (Load) | ~150MB | <300MB | Under sustained load |
| CPU Usage (Idle) | <1% | <5% | Idle state |
| CPU Usage (Load) | ~10% | <50% | At 500 req/s |
| Database Size Growth | ~10KB/task | N/A | Depends on task data |
| Cold Start Time | <2s | <5s | Time to first request |

### Load Testing

**Apache Bench:**
```bash
# 10,000 requests, 100 concurrent
ab -n 10000 -c 100 http://localhost:3000/health

# Expected results:
# Requests per second: ~1000-2000
# Time per request: <100ms (mean)
# Failed requests: 0
```

**k6:**
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export let options = {
  stages: [
    { duration: '30s', target: 50 },  // Ramp up
    { duration: '1m', target: 100 },  // Sustained load
    { duration: '30s', target: 0 },   // Ramp down
  ],
  thresholds: {
    'http_req_duration': ['p(95)<100'], // 95% of requests < 100ms
    'http_req_failed': ['rate<0.01'],   // <1% errors
  },
};

export default function () {
  let res = http.get('http://localhost:3000/health');
  check(res, {
    'status is 200': (r) => r.status === 200,
    'response time < 100ms': (r) => r.timings.duration < 100,
  });
  sleep(0.1);
}
```

**Run:**
```bash
k6 run load-test.js
```

### Optimization Tips

1. **Database Optimization:**
   - SQLite uses WAL mode by default (good for concurrency)
   - Index frequently queried fields
   - Use prepared statements (already done)
   - Consider read replicas for high read load

2. **Caching:**
   - Add Redis for session/cache data (future enhancement)
   - Cache expensive queries
   - Use HTTP caching headers

3. **Connection Pooling:**
   - SQLite is single-connection by design
   - For high concurrency, consider PostgreSQL migration

4. **Horizontal Scaling:**
   - Deploy multiple instances behind load balancer
   - Use sticky sessions for consistency
   - Share database via NFS or S3 (careful with concurrency)

---

## Troubleshooting

### Common Issues

#### 1. Port Already in Use

**Error:**
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

**Solution:**
```bash
# Find process using port 3000
lsof -ti:3000

# Kill process
kill -9 $(lsof -ti:3000)

# Or use different port
export PORT=3001
npm start
```

#### 2. Database Locked

**Error:**
```
Error: SQLITE_BUSY: database is locked
```

**Solution:**
- SQLite allows one writer at a time
- Ensure no other process is writing to DB
- Check for long-running transactions
- Consider increasing timeout:
  ```typescript
  db.pragma('busy_timeout = 5000'); // 5 seconds
  ```

#### 3. Out of Memory

**Error:**
```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

**Solution:**
```bash
# Increase Node.js heap size
export NODE_OPTIONS="--max-old-space-size=2048"  # 2GB
npm start
```

#### 4. Health Check Failing

**Symptoms:**
- Load balancer reports instance unhealthy
- Kubernetes restarts pod

**Debug:**
```bash
# Test health endpoint
curl -v http://localhost:3000/health

# Check logs
docker logs dashboard-backend
kubectl logs -l app=dashboard-backend

# Check database
curl http://localhost:3000/health/db
```

**Common Causes:**
- Database file permissions
- Database corruption
- Network policy blocking health check
- Probe timeout too short

#### 5. High Error Rate

**Symptoms:**
- `http_errors_total` metric increasing
- 500 errors in logs

**Debug:**
```bash
# Check logs
docker logs dashboard-backend --tail 100

# Check error types
curl http://localhost:3000/metrics | grep http_errors

# Test endpoints manually
curl -v http://localhost:3000/projects/123/tasks
```

**Common Causes:**
- Invalid request data
- Database errors
- Application bugs
- Resource exhaustion

### Debug Mode

**Enable Debug Logging:**
```bash
export LOG_LEVEL=debug
npm start
```

**Check Database:**
```bash
# Install sqlite3 CLI
npm install -g sqlite3

# Open database
sqlite3 /var/lib/dashboard/dashboard.db

# Check schema
.schema

# Check data
SELECT * FROM tasks LIMIT 10;

# Check integrity
PRAGMA integrity_check;
```

**Profile Performance:**
```bash
# Enable Node.js profiler
node --prof dist/server.js

# Process profile
node --prof-process isolate-*.log
```

---

## Rollback Procedures

### Docker

**Tag Previous Version:**
```bash
docker tag dashboard-backend:latest dashboard-backend:previous
docker tag dashboard-backend:v1.2.0 dashboard-backend:latest
```

**Rollback:**
```bash
docker stop dashboard-backend
docker rm dashboard-backend
docker run -d \
  --name dashboard-backend \
  -p 3000:3000 \
  -v /var/lib/dashboard:/data \
  dashboard-backend:previous
```

### Kubernetes

**Rollback Deployment:**
```bash
# View rollout history
kubectl rollout history deployment/dashboard-backend

# Rollback to previous version
kubectl rollout undo deployment/dashboard-backend

# Rollback to specific revision
kubectl rollout undo deployment/dashboard-backend --to-revision=2

# Check status
kubectl rollout status deployment/dashboard-backend
```

**Automatic Rollback on Failure:**
```yaml
spec:
  progressDeadlineSeconds: 600
  revisionHistoryLimit: 10
  strategy:
    rollingUpdate:
      maxUnavailable: 0
```

### Database Rollback

**Backup Before Deployment:**
```bash
# Create backup
cp /var/lib/dashboard/dashboard.db /var/lib/dashboard/dashboard.db.backup-$(date +%Y%m%d-%H%M%S)

# Or in Kubernetes
kubectl exec -it dashboard-backend-xxx -- cp /data/dashboard.db /data/dashboard.db.backup
```

**Restore Backup:**
```bash
# Stop service
systemctl stop dashboard-backend

# Restore backup
cp /var/lib/dashboard/dashboard.db.backup-20251020-143000 /var/lib/dashboard/dashboard.db

# Start service
systemctl start dashboard-backend
```

**Kubernetes:**
```bash
# Copy backup to pod
kubectl cp dashboard.db.backup dashboard-backend-xxx:/data/dashboard.db

# Restart pod to pick up new database
kubectl delete pod -l app=dashboard-backend
```

---

## Deployment Checklist

### Pre-Deployment

- [ ] Build and test locally
- [ ] Run test suite (`npm test`)
- [ ] Test health endpoints
- [ ] Test metrics endpoint
- [ ] Backup production database
- [ ] Review environment variables
- [ ] Test rollback procedure
- [ ] Notify stakeholders

### Deployment

- [ ] Deploy to staging environment
- [ ] Run smoke tests
- [ ] Monitor error rates
- [ ] Check health check status
- [ ] Verify database migrations
- [ ] Deploy to production (canary/rolling)
- [ ] Monitor metrics for 15 minutes
- [ ] Verify all endpoints functional

### Post-Deployment

- [ ] Monitor error rates for 24 hours
- [ ] Check database size growth
- [ ] Review logs for warnings
- [ ] Update documentation
- [ ] Tag release in git
- [ ] Archive deployment artifacts
- [ ] Post-mortem if issues occurred

---

## Support & Maintenance

### Logs

**Location:**
- **Systemd:** `journalctl -u dashboard-backend -f`
- **Docker:** `docker logs dashboard-backend -f`
- **Kubernetes:** `kubectl logs -l app=dashboard-backend -f`

**Log Format:** JSON (Fastify default)

**Example:**
```json
{
  "level": 30,
  "time": 1760971002276,
  "pid": 11997,
  "hostname": "dashboard-backend-abc123",
  "reqId": "req-1",
  "req": {
    "method": "GET",
    "url": "/health"
  },
  "res": {
    "statusCode": 200
  },
  "responseTime": 2.5,
  "msg": "request completed"
}
```

### Database Maintenance

**Vacuum Database:**
```bash
sqlite3 /var/lib/dashboard/dashboard.db "VACUUM;"
```

**Analyze Tables:**
```bash
sqlite3 /var/lib/dashboard/dashboard.db "ANALYZE;"
```

**Check Size:**
```bash
ls -lh /var/lib/dashboard/dashboard.db
```

### Backup Strategy

**Daily Backup:**
```bash
#!/bin/bash
# /etc/cron.daily/dashboard-backup

DATE=$(date +%Y%m%d)
BACKUP_DIR=/var/backups/dashboard
mkdir -p $BACKUP_DIR

# Backup database
cp /var/lib/dashboard/dashboard.db $BACKUP_DIR/dashboard-$DATE.db

# Compress
gzip $BACKUP_DIR/dashboard-$DATE.db

# Delete backups older than 30 days
find $BACKUP_DIR -name "dashboard-*.db.gz" -mtime +30 -delete
```

**Kubernetes CronJob:**
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: dashboard-backup
spec:
  schedule: "0 2 * * *"  # 2 AM daily
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: backup
            image: dashboard-backend:latest
            command:
            - /bin/sh
            - -c
            - |
              DATE=$(date +%Y%m%d)
              cp /data/dashboard.db /backups/dashboard-$DATE.db
              gzip /backups/dashboard-$DATE.db
          volumeMounts:
          - name: data
            mountPath: /data
          - name: backups
            mountPath: /backups
          restartPolicy: OnFailure
          volumes:
          - name: data
            persistentVolumeClaim:
              claimName: dashboard-backend-pvc
          - name: backups
            persistentVolumeClaim:
              claimName: dashboard-backups-pvc
```

---

## Contact & Escalation

**Support Channels:**
- **Issues:** GitHub Issues
- **Email:** ops@example.com
- **Slack:** #dashboard-backend

**Escalation Path:**
1. Level 1: Check logs, health endpoints, metrics
2. Level 2: Restart service, review recent changes
3. Level 3: Rollback deployment, restore database backup
4. Level 4: Contact development team

**Service Level Objectives (SLO):**
- **Availability:** 99.9% uptime (8.76 hours downtime/year)
- **Latency:** P95 < 50ms
- **Error Rate:** < 1%

---

**End of Guide**
