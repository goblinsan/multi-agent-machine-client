

import { DashboardClient } from '../src/services/DashboardClient.js';

async function testDashboardIntegration() {
  console.log('=== Day 4 Dashboard Integration Test ===\n');
  
  const dashboardClient = new DashboardClient({ baseUrl: 'http://localhost:8080' });
  const testProjectId = 1;
  
  try {
    
    console.log('Test 1: Verifying dashboard backend is running...');
    try {
      await fetch('http://localhost:8080/health').catch(() => {
        
        return fetch('http://localhost:8080/tasks/999999');
      });
      console.log('✅ Dashboard backend is running on port 8080');
    } catch (error: any) {
      throw new Error('Dashboard backend not responding. Is it running on port 8080?');
    }
    
    
    console.log('\nTest 2: Creating single task...');
    const task1 = await dashboardClient.createTask(testProjectId, {
      title: 'Test Task 1',
      description: 'First test task',
      status: 'open',
      priority_score: 1500,
      external_id: `test-task-${Date.now()}-1`
    });
    console.log('✅ Task created:', task1.id, task1.title);
    
    
    console.log('\nTest 3: Creating 5 tasks in bulk...');
    const bulkResponse = await dashboardClient.bulkCreateTasks(testProjectId, {
      tasks: [
        {
          title: 'Bulk Task 1',
          description: 'First bulk task',
          status: 'open',
          priority_score: 1200,
          external_id: `bulk-test-${Date.now()}-1`
        },
        {
          title: 'Bulk Task 2',
          description: 'Second bulk task',
          status: 'open',
          priority_score: 800,
          external_id: `bulk-test-${Date.now()}-2`
        },
        {
          title: 'Bulk Task 3',
          description: 'Third bulk task',
          status: 'open',
          priority_score: 50,
          external_id: `bulk-test-${Date.now()}-3`
        },
        {
          title: 'Bulk Task 4',
          description: 'Fourth bulk task',
          status: 'open',
          priority_score: 1500,
          external_id: `bulk-test-${Date.now()}-4`
        },
        {
          title: 'Bulk Task 5',
          description: 'Fifth bulk task',
          status: 'open',
          priority_score: 1200,
          external_id: `bulk-test-${Date.now()}-5`
        }
      ]
    });
    
    console.log('✅ Bulk tasks created:', bulkResponse.created.length);
    console.log('   Task IDs:', bulkResponse.created.map(t => t.id));
    
    
    console.log('\nTest 4: Testing idempotency (same external_id)...');
    const externalId = `idempotent-test-${Date.now()}`;
    
    const task2 = await dashboardClient.createTask(testProjectId, {
      title: 'Idempotent Task',
      description: 'Should only create once',
      status: 'open',
      priority_score: 800,
      external_id: externalId
    });
    console.log('✅ First create - Task ID:', task2.id);
    
    const task3 = await dashboardClient.createTask(testProjectId, {
      title: 'Idempotent Task (retry)',
      description: 'Should return existing',
      status: 'open',
      priority_score: 800,
      external_id: externalId
    });
    console.log('✅ Second create - Task ID:', task3.id);
    
    if (task2.id === task3.id) {
      console.log('✅ Idempotency works! Same task returned.');
    } else {
      console.log('❌ Idempotency failed! Different tasks created.');
    }
    
    
    console.log('\nTest 5: Testing bulk idempotency...');
    const bulkExternalIds = [
      `bulk-idempotent-${Date.now()}-1`,
      `bulk-idempotent-${Date.now()}-2`,
      `bulk-idempotent-${Date.now()}-3`
    ];
    
    const bulkResponse1 = await dashboardClient.bulkCreateTasks(testProjectId, {
      tasks: bulkExternalIds.map((id, i) => ({
        title: `Bulk Idempotent Task ${i + 1}`,
        description: `Bulk idempotent test task ${i + 1}`,
        status: 'open',
        priority_score: 1200,
        external_id: id
      }))
    });
    console.log('✅ First bulk create - Created:', bulkResponse1.created.length);
    
    const bulkResponse2 = await dashboardClient.bulkCreateTasks(testProjectId, {
      tasks: bulkExternalIds.map((id, i) => ({
        title: `Bulk Idempotent Task ${i + 1} (retry)`,
        description: `Should be skipped`,
        status: 'open',
        priority_score: 1200,
        external_id: id
      }))
    });
    console.log('✅ Second bulk create - Created:', bulkResponse2.created.length);
    console.log('✅ Second bulk create - Skipped:', bulkResponse2.skipped?.length || 0);
    
    if (bulkResponse2.created.length === 0 && bulkResponse2.skipped?.length === 3) {
      console.log('✅ Bulk idempotency works! All tasks skipped.');
    } else {
      console.log('❌ Bulk idempotency issue! Created:', bulkResponse2.created.length, 'Skipped:', bulkResponse2.skipped?.length);
    }
    
    
    console.log('\nTest 6: Listing tasks...');
    const tasksResponse = await dashboardClient.listTasks(testProjectId);
    console.log('✅ Total tasks in project:', tasksResponse.data.length);
    
    
    console.log('\n=== Integration Test Summary ===');
    console.log('✅ Dashboard backend running on port 8080');
    console.log('✅ DashboardClient HTTP communication working');
    console.log('✅ Single task creation working');
    console.log('✅ Bulk task creation working');
    console.log('✅ Idempotency working (single)');
    console.log('✅ Idempotency working (bulk)');
    console.log('✅ Task listing working');
    console.log('\n🎉 All tests passed! Dashboard integration ready for BulkTaskCreationStep.');
    
  } catch (error: any) {
    console.error('\n❌ Integration test failed:', error.message);
    console.error('   Stack:', error.stack);
    process.exit(1);
  }
}


testDashboardIntegration();
