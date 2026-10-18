// Safety guards live in the imported test: loopback URL + known local DB.
process.env.FTT_TEST_LOGISTICS = '1';
await import('./full-marketplace-local-e2e.mjs');
