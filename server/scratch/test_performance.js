const axios = require('axios');

async function testPerformance() {
  console.log('--- Starting Performance and Optimization Verification ---');

  // Let's call the dashboard tasks endpoint from local server (port 5000)
  const url = 'http://localhost:5000/api/tester/dashboard-tasks?month=06&year=2026';
  
  console.log('\nTesting Single Flight Request Collapsing (Concurrent Requests)...');
  const startConcurrent = Date.now();
  
  try {
    // Fire two identical requests in parallel
    const [res1, res2] = await Promise.all([
      axios.get(url),
      axios.get(url)
    ]);
    
    const durationConcurrent = Date.now() - startConcurrent;
    console.log(`- Request 1 status: ${res1.status}`);
    console.log(`- Request 2 status: ${res2.status}`);
    console.log(`- Both requests finished in: ${durationConcurrent}ms`);
    console.log(`- Received ${res1.data.issues?.length || 0} issues.`);
  } catch (err) {
    console.error('Error during concurrent requests:', err.message);
  }

  console.log('\nTesting Caching is Removed (Consecutive Request)...');
  const startConsecutive = Date.now();
  try {
    // Fire a third consecutive request immediately after
    const res3 = await axios.get(url);
    const durationConsecutive = Date.now() - startConsecutive;
    console.log(`- Request 3 status: ${res3.status}`);
    console.log(`- Consecutive request finished in: ${durationConsecutive}ms (Should be fresh fetch, ~5s)`);
  } catch (err) {
    console.error('Error during consecutive request:', err.message);
  }

  console.log('\n--- Verification Completed ---');
}

testPerformance();
