import HyperExpress from '../lib/uws-compat.js';
import openapiSpec from '../openapi.json' with { type: 'json' };

const router = new HyperExpress.Router();

router.get('/openapi.json', (_request, response) => {
  response.json(openapiSpec);
});

const openapiRouter = router;
export default openapiRouter;
