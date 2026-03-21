import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPersistentStudioControlPlaneGraph } from './workflow.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const graph = await createPersistentStudioControlPlaneGraph({
  repoRoot,
  checkpointPath: './apps/langgraph-control-plane/.control-plane/studio-checkpoints.json',
});

export { graph };

export default graph;
