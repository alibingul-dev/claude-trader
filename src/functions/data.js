// Public read-only JSON for the dashboard: GET /api/data
const { app } = require('@azure/functions');
const eng = require('../lib/engine');

app.http('data', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'data',
  handler: async () => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    try {
      return { status: 200, headers, jsonBody: await eng.dashboardData() };
    } catch (e) {
      return { status: 500, headers, jsonBody: { error: e.message } };
    }
  },
});
