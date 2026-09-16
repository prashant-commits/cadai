// Installs `indexedDB` / `IDBKeyRange` globals so storage code runs under the
// node test environment.
import 'fake-indexeddb/auto';

// Placeholder gateway credential. createCadAgent() constructs its models
// eagerly, so every suite that builds an agent would otherwise fail when the
// developer has not exported a key - and would start passing or failing based
// on the contents of a local .env rather than the code. No test makes a real
// network call; the model layer is mocked at the call site.
process.env.EXPLABS_API_KEY ||= 'test-explabs-key';

// Research is opt-out in the app but off in tests: it would add two model
// calls and an interrupt to every graph run and break the exact call counts
// the HIL suites assert. graph-research.test.ts turns it on explicitly, with
// the stub provider, so a developer's own TAVILY_API_KEY never leaks in.
process.env.CADAI_RESEARCH = 'off';
delete process.env.TAVILY_API_KEY;
delete process.env.CADAI_RESEARCH_STUB;
