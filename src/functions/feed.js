// Public Agent Resume entries for the crypto trader agent: GET /api/feed (newest first, max 60)
const { app } = require('@azure/functions');
const sq = require('../lib/square');

app.http('feed', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'feed',
  handler: async () => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    try { return { status: 200, headers, jsonBody: { posts: await sq.feedList() } }; }
    catch (e) { return { status: 500, headers, jsonBody: { error: e.message } }; }
  },
});
