// Installs `indexedDB` / `IDBKeyRange` globals so storage code runs under the
// node test environment.
import 'fake-indexeddb/auto';

// Placeholder gateway credential. createCadAgent() constructs its models
// eagerly, so every suite that builds an agent would otherwise fail when the
// developer has not exported a key - and would start passing or failing based
// on the contents of a local .env rather than the code. No test makes a real
// network call; the model layer is mocked at the call site.
process.env.EXPLABS_API_KEY ||= 'test-explabs-key';

