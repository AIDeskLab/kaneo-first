// Upstream auth exits at import when AUTH_SECRET is missing. Unit tests
// import that module without the integration setup file.
if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
  process.env.AUTH_SECRET = "test-secret-with-at-least-32-chars";
}
