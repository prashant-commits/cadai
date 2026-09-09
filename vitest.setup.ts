// Installs `indexedDB` / `IDBKeyRange` globals so storage code runs under the
// node test environment.
import 'fake-indexeddb/auto';

// Placeholder provider credentials. createCadAgent() constructs its models
// eagerly, so every suite that builds an agent would otherwise fail on whichever
// key the developer happens not to have exported - and would start passing or
// failing based on the contents of a local .env rather than the code. No test
// makes a real network call; the model layer is mocked at the call site.
process.env.GOOGLE_API_KEY ||= 'test-google-key';
process.env.EXPLABS_API_KEY ||= 'test-explabs-key';
