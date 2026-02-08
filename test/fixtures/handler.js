// Test fixture: simulates a request handler that fails on null err
// Used by the launch video demo and integration test

function processRequest(req, err, user) { // line 4
  const msg = err.message;                // line 5 — throws if err is null
  return { ok: false, msg };              // line 6
}

// Simulate incoming request
const req = { url: "/api/data", method: "POST", headers: { host: "localhost" } };
const err = null;        // line 10 — this is the bug: err is null
const user = "alice";    // line 11

processRequest(req, err, user); // line 13 — crashes here
